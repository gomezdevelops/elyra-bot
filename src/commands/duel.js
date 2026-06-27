// src/commands/duel.js
// XP duel system — challenge, accept (triggers word game), decline, cancel, history.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { getLevelColor } = require('../utils/xpHandler');
const { checkAndUnlock, TIER_COLORS } = require('../utils/achievements');
const { resolveAchievementsChannel } = require('../utils/xpHandler');

const DUEL_EXPIRE_MS  = 5 * 60_000; // 5 min to accept
const GAME_DURATION   = 30_000;      // 30 seconds of play
const MIN_WORD_LENGTH = 3;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('duel')
    .setDescription('Challenge another user to a word-duel for XP!')
    .addSubcommand(sub =>
      sub.setName('challenge')
        .setDescription('Challenge a user to a duel.')
        .addUserOption(o => o.setName('opponent').setDescription('Who do you want to duel?').setRequired(true))
        .addIntegerOption(o => o.setName('wager').setDescription('XP to wager (min 10)').setMinValue(10).setRequired(true))
    )
    .addSubcommand(sub => sub.setName('accept').setDescription('Accept an incoming duel challenge.'))
    .addSubcommand(sub => sub.setName('decline').setDescription('Decline an incoming duel challenge.'))
    .addSubcommand(sub => sub.setName('cancel').setDescription('Cancel your outgoing duel challenge.'))
    .addSubcommand(sub =>
      sub.setName('history')
        .setDescription('View recent duel history.')
        .addUserOption(o => o.setName('user').setDescription('User to check (defaults to you)').setRequired(false))
    ),

  async execute(interaction, client) {
    await interaction.deferReply();

    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const userId  = interaction.user.id;

    // ── CHALLENGE ────────────────────────────────────────────────────────────
    if (sub === 'challenge') {
      const opponent = interaction.options.getUser('opponent');
      const wager    = interaction.options.getInteger('wager');

      if (opponent.id === userId)  return interaction.editReply({ embeds: [errEmbed('You can\'t duel yourself!')] });
      if (opponent.bot)            return interaction.editReply({ embeds: [errEmbed('You can\'t duel a bot!')] });

      const existing = db.getPendingDuelByChallenger(guildId, userId);
      if (existing && Date.now() - existing.created_at < DUEL_EXPIRE_MS) {
        return interaction.editReply({ embeds: [errEmbed('You already have a pending challenge! Use `/duel cancel` to cancel it.')] });
      }

      const challengerData = db.getUser(userId, guildId);
      const opponentData   = db.getUser(opponent.id, guildId);

      if (challengerData.xp < wager)
        return interaction.editReply({ embeds: [errEmbed(`You only have **${challengerData.xp.toLocaleString()} XP** but the wager is **${wager.toLocaleString()}**.`)] });
      if (opponentData.xp < wager)
        return interaction.editReply({ embeds: [errEmbed(`${opponent.username} only has **${opponentData.xp.toLocaleString()} XP** and can't cover the wager.`)] });

      db.createDuel(guildId, userId, opponent.id, wager);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xFF6B35)
            .setTitle('⚔️ Duel Challenge Issued!')
            .setDescription(
              `<@${userId}> has challenged ${opponent} to a **Word Duel**!\n\n` +
              `**Wager:** ${wager.toLocaleString()} XP\n\n` +
              `${opponent}, use \`/duel accept\` or \`/duel decline\` within **5 minutes**.`
            )
            .addFields(
              { name: '🗡️ Challenger', value: `<@${userId}>\nLv. ${challengerData.level} · ${challengerData.xp.toLocaleString()} XP`, inline: true },
              { name: '🛡️ Opponent',   value: `${opponent}\nLv. ${opponentData.level} · ${opponentData.xp.toLocaleString()} XP`, inline: true },
            )
            .setFooter({ text: 'How it works: when accepted, you\'ll race to form the most words from a set of random letters in 30 seconds.' })
            .setTimestamp(),
        ],
      });
    }

    // ── ACCEPT ───────────────────────────────────────────────────────────────
    if (sub === 'accept') {
      const duel = db.getPendingDuel(guildId, userId);
      if (!duel) return interaction.editReply({ embeds: [errEmbed("You don't have a pending challenge to accept.")] });

      if (Date.now() - duel.created_at > DUEL_EXPIRE_MS) {
        db.cancelDuel(duel.id);
        return interaction.editReply({ embeds: [errEmbed('That challenge has expired.')] });
      }

      const challengerData = db.getUser(duel.challenger, guildId);
      const opponentData   = db.getUser(userId, guildId);

      if (challengerData.xp < duel.wager || opponentData.xp < duel.wager) {
        db.cancelDuel(duel.id);
        return interaction.editReply({ embeds: [errEmbed('One of you no longer has enough XP. Duel cancelled.')] });
      }

      // ── Generate letters ────────────────────────────────────────────────
      const letters = generateLetters();
      const channel = interaction.channel;

      // Mark as active in the active duels map (handled in index.js)
      client.activeDuels = client.activeDuels || new Map();

      const gameState = {
        duelId:      duel.id,
        guildId,
        channelId:   channel.id,
        letters,
        challenger:  duel.challenger,
        opponent:    userId,
        wager:       duel.wager,
        scores:      { [duel.challenger]: 0, [userId]: 0 },
        wordCounts:  { [duel.challenger]: 0, [userId]: 0 },
        usedWords:   new Set(),
        claimedBy:   {},    // word → userId
        startedAt:   Date.now(),
        active:      true,
      };

      client.activeDuels.set(channel.id, gameState);

      // ── Announce game start ─────────────────────────────────────────────
      const letterDisplay = letters.map(l => `**${l.toUpperCase()}**`).join('  ');

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xFFD700)
            .setTitle('⚔️ Duel Accepted — Get Ready!')
            .setDescription(
              `<@${duel.challenger}> vs <@${userId}>\n\n` +
              `The battle begins in **3 seconds...**\n\n` +
              `**Wager:** ${duel.wager.toLocaleString()} XP\n` +
              `**Duration:** 30 seconds`
            )
            .setFooter({ text: 'Form as many words as possible from the letters below. Min 3 letters. First to claim a word wins it.' })
            .setTimestamp(),
        ],
      });

      // ── Countdown then reveal letters ───────────────────────────────────
      await sleep(3000);

      const gameMsg = await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5B8FFF)
            .setTitle('🔤 Word Duel — GO!')
            .setDescription(
              `**Your letters:**\n\n${letterDisplay}\n\n` +
              `Type words using only these letters in this channel!\n` +
              `⏱️ **30 seconds on the clock.**`
            )
            .addFields(
              { name: '📜 Rules', value: '• Minimum **3 letters** per word\n• Each letter can only be used as many times as it appears\n• First to type a word claims it — duplicates don\'t count\n• Real English words only' },
              { name: '🗡️ Challenger', value: `<@${duel.challenger}> — 0 pts`, inline: true },
              { name: '🛡️ Opponent',   value: `<@${userId}> — 0 pts`,          inline: true },
            )
            .setFooter({ text: `⚔️ Wager: ${duel.wager.toLocaleString()} XP · Timer started` })
            .setTimestamp(),
        ],
      });

      gameState.gameMsg = gameMsg;

      // ── Countdown updates ───────────────────────────────────────────────
      const tickTimes = [20000, 10000, 5000]; // ms after start to post warnings
      for (const t of tickTimes) {
        setTimeout(async () => {
          if (!gameState.active) return;
          const remaining = Math.round((GAME_DURATION - (Date.now() - gameState.startedAt)) / 1000);
          await channel.send({
            content: `⏱️ **${remaining} seconds remaining!** <@${duel.challenger}> · <@${userId}>`,
          }).catch(() => {});
        }, t);
      }

      // ── End game after 30s ──────────────────────────────────────────────
      setTimeout(() => endDuelGame(gameState, channel, client), GAME_DURATION);

      return; // game is now live, index.js handles word messages
    }

    // ── DECLINE ──────────────────────────────────────────────────────────────
    if (sub === 'decline') {
      const duel = db.getPendingDuel(guildId, userId);
      if (!duel) return interaction.editReply({ embeds: [errEmbed("You don't have a pending challenge to decline.")] });
      db.cancelDuel(duel.id);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x95A5A6)
            .setTitle('⚔️ Duel Declined')
            .setDescription(`<@${userId}> has declined the duel from <@${duel.challenger}>.`)
            .setTimestamp(),
        ],
      });
    }

    // ── CANCEL ───────────────────────────────────────────────────────────────
    if (sub === 'cancel') {
      const duel = db.getPendingDuelByChallenger(guildId, userId);
      if (!duel || Date.now() - duel.created_at > DUEL_EXPIRE_MS)
        return interaction.editReply({ embeds: [errEmbed("You don't have an active outgoing challenge.")] });
      db.cancelDuel(duel.id);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x95A5A6)
            .setTitle('⚔️ Challenge Cancelled')
            .setDescription(`Your duel challenge against <@${duel.opponent}> has been cancelled.`)
            .setTimestamp(),
        ],
      });
    }

    // ── HISTORY ──────────────────────────────────────────────────────────────
    if (sub === 'history') {
      const target  = interaction.options.getUser('user') ?? interaction.user;
      const history = db.getDuelHistory(guildId, target.id);

      if (!history.length) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95A5A6)
              .setTitle('⚔️ Duel History')
              .setDescription(`${target.username} hasn't participated in any duels yet.`)
              .setTimestamp(),
          ],
        });
      }

      const userData = db.getUser(target.id, guildId);
      const wins     = userData.duel_wins   || 0;
      const losses   = userData.duel_losses || 0;
      const total    = wins + losses;
      const winRate  = total > 0 ? Math.floor((wins / total) * 100) : 0;

      const lines = history.map(d => {
        const won     = d.winner === target.id;
        const otherId = d.challenger === target.id ? d.opponent : d.challenger;
        const when    = new Date(d.resolved_at).toLocaleDateString();
        return `${won ? '🏆' : '💀'} **vs <@${otherId}>** · ${won ? 'Won' : 'Lost'} **${d.wager.toLocaleString()} XP** · ${when}`;
      });

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(getLevelColor(userData.level))
            .setTitle(`⚔️ ${target.username}'s Duel History`)
            .setThumbnail(target.displayAvatarURL({ dynamic: true }))
            .addFields(
              { name: '🏆 Wins',     value: `**${wins}**`,     inline: true },
              { name: '💀 Losses',   value: `**${losses}**`,   inline: true },
              { name: '📊 Win Rate', value: `**${winRate}%**`, inline: true },
              { name: 'Recent Duels', value: lines.join('\n') }
            )
            .setTimestamp(),
        ],
      });
    }
  },
};

// ─── Word Game Helpers ────────────────────────────────────────────────────────

const WORD_SET = new Set(require('an-array-of-english-words'));

const VOWELS      = 'aaeeiioouuy'.split('');
const CONSONANTS  = 'bcdfghlmnprst'.split('');

/**
 * Generate a set of 9 letters guaranteed to produce at least 60 valid words.
 */
function generateLetters(minWords = 60, maxAttempts = 100) {
  function canMake(word, pool) {
    const p = [...pool];
    for (const c of word) {
      const i = p.indexOf(c);
      if (i === -1) return false;
      p.splice(i, 1);
    }
    return true;
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const pool = [];
    for (let i = 0; i < 4; i++) pool.push(VOWELS[Math.floor(Math.random() * VOWELS.length)]);
    for (let i = 0; i < 5; i++) pool.push(CONSONANTS[Math.floor(Math.random() * CONSONANTS.length)]);

    const count = [...WORD_SET].filter(w =>
      w.length >= MIN_WORD_LENGTH && canMake(w, pool)
    ).length;

    if (count >= minWords) return pool;
  }

  // Fallback: guaranteed playable set
  return ['a', 'e', 'i', 'o', 'r', 's', 't', 'n', 'l'];
}

/**
 * Check if a word can be formed from the given letter pool.
 */
function canFormWord(word, letters) {
  const pool = [...letters];
  for (const c of word.toLowerCase()) {
    const i = pool.indexOf(c);
    if (i === -1) return false;
    pool.splice(i, 1);
  }
  return true;
}

/**
 * Validate a word: real word + long enough + formable from letters.
 */
function isValidWord(word, letters) {
  const w = word.toLowerCase().trim();
  if (w.length < MIN_WORD_LENGTH) return false;
  if (!WORD_SET.has(w)) return false;
  if (!canFormWord(w, letters)) return false;
  return true;
}

/**
 * Called when a message comes in during an active duel.
 * Returns: 'valid' | 'already_claimed' | 'invalid' | 'not_player'
 */
function handleDuelWord(gameState, userId, word) {
  if (!gameState.active) return 'not_active';
  if (userId !== gameState.challenger && userId !== gameState.opponent) return 'not_player';

  const w = word.toLowerCase().trim();

  if (gameState.usedWords.has(w)) return 'already_claimed';
  if (!isValidWord(w, gameState.letters)) return 'invalid';

  // Claim the word
  gameState.usedWords.add(w);
  gameState.claimedBy[w] = userId;
  gameState.scores[userId]   = (gameState.scores[userId]   || 0) + w.length; // score = word length
  gameState.wordCounts[userId] = (gameState.wordCounts[userId] || 0) + 1;

  return 'valid';
}

/**
 * End the duel game, tally scores, transfer XP.
 */
async function endDuelGame(gameState, channel, client) {
  if (!gameState.active) return;
  gameState.active = false;

  client.activeDuels.delete(channel.id);

  const { challenger, opponent, wager, scores, wordCounts, claimedBy, duelId, guildId } = gameState;

  const chalScore = scores[challenger] || 0;
  const oppScore  = scores[opponent]   || 0;

  let winnerId, loserId;
  const isTie = chalScore === oppScore;

  if (!isTie) {
    winnerId = chalScore > oppScore ? challenger : opponent;
    loserId  = winnerId === challenger ? opponent : challenger;
  }

  // Build word list per player
  const chalWords = Object.entries(claimedBy).filter(([,u]) => u === challenger).map(([w]) => w);
  const oppWords  = Object.entries(claimedBy).filter(([,u]) => u === opponent).map(([w]) => w);

  let description, xferText, newlyUnlocked = [];

  if (isTie) {
    description = `🤝 **It's a tie!** Both players scored **${chalScore} points**. No XP is transferred.`;
    xferText = 'No XP transferred — tied game.';
    db.resolveDuel(duelId, null); // tie
  } else {
    const { actualWager } = db.recordDuelResult(guildId, winnerId, loserId, wager);
    db.resolveDuel(duelId, winnerId);
    description = `🏆 **<@${winnerId}> wins the duel!** They take **${actualWager.toLocaleString()} XP** from <@${loserId}>!`;
    xferText = `${actualWager.toLocaleString()} XP transferred`;
    newlyUnlocked = checkAndUnlock(winnerId, guildId);
  }

  const formatWords = (words) =>
    words.length > 0
      ? words.sort((a,b) => b.length - a.length).slice(0, 12).join(', ') + (words.length > 12 ? ` +${words.length - 12} more` : '')
      : '*No words*';

  const embed = new EmbedBuilder()
    .setColor(isTie ? 0x95A5A6 : 0xFFD700)
    .setTitle('⚔️ Duel Over!')
    .setDescription(description)
    .addFields(
      {
        name: `🗡️ <@${challenger}> — ${wordCounts[challenger] || 0} words · ${chalScore} pts`,
        value: formatWords(chalWords),
        inline: false,
      },
      {
        name: `🛡️ <@${opponent}> — ${wordCounts[opponent] || 0} words · ${oppScore} pts`,
        value: formatWords(oppWords),
        inline: false,
      },
    )
    .setFooter({ text: `Scoring: 1 point per letter · ${xferText}` })
    .setTimestamp();

  await channel.send({ embeds: [embed] }).catch(() => {});

  // Send achievement unlock(s) to the dedicated achievements channel (falls back to duel channel)
  if (newlyUnlocked.length) {
    const achChannel = resolveAchievementsChannel(channel.guild) || channel;
    for (const ach of newlyUnlocked) {
      achChannel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(TIER_COLORS[ach.tier] || 0xFFD700)
            .setTitle('🎖️ Achievement Unlocked!')
            .setDescription(`<@${winnerId}> just unlocked **${ach.emoji} ${ach.name}**!\n*${ach.desc}*`)
            .setFooter({ text: `${ach.tier} Tier · Use /achievements to see all` })
            .setTimestamp(),
        ],
      }).catch(() => {});
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Export helpers for use in index.js
module.exports.handleDuelWord  = handleDuelWord;
module.exports.endDuelGame     = endDuelGame;
module.exports.isValidWord     = isValidWord;