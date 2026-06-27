// src/commands/scramble.js
// Word scramble game — bot posts a scrambled word, first to unscramble wins XP.
// Can be played solo or as a duel (2 players, wager XP).

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { checkAndUnlock, TIER_COLORS } = require('../utils/achievements');

const ROUND_TIME  = 20_000; // 20s per round
const SOLO_ROUNDS = 5;
const DUEL_ROUNDS = 7;

// Curated word list by difficulty tier
const WORDS = {
  easy: [
    'apple','cloud','table','chair','happy','light','water','music','black','white',
    'plant','bread','stone','night','river','green','earth','flame','sword','crown',
    'tiger','eagle','storm','frost','bloom','spark','ghost','candy','brush','chess',
  ],
  medium: [
    'dragon','castle','forest','silver','bridge','frozen','breeze','hunter','mirror',
    'galaxy','planet','socket','blizzard','crystal','volcano','thunder','phantom',
    'lantern','compass','horizon','velvet','cobalt','magnet','cipher','matrix',
  ],
  hard: [
    'labyrinth','celestial','equilibrium','tempestuous','phosphorus','cataclysm',
    'resonance','chromatic','bioluminescent','kaleidoscope','archipelago','serendipity',
    'turbulence','metamorphosis','catastrophe','luminescent','constellation','hypnotic',
  ],
};
const ALL_WORDS = [...WORDS.easy, ...WORDS.medium, ...WORDS.hard];

function scramble(word) {
  const arr = word.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  // Ensure scrambled !== original
  const result = arr.join('');
  return result === word ? scramble(word) : result;
}

function pickWord(usedWords) {
  const available = ALL_WORDS.filter(w => !usedWords.has(w));
  if (!available.length) return ALL_WORDS[Math.floor(Math.random() * ALL_WORDS.length)];
  return available[Math.floor(Math.random() * available.length)];
}

function getDifficulty(word) {
  if (WORDS.hard.includes(word))   return { label: '🔴 Hard',   bonus: 3 };
  if (WORDS.medium.includes(word)) return { label: '🟡 Medium', bonus: 2 };
  return                                   { label: '🟢 Easy',   bonus: 1 };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('scramble')
    .setDescription('🔤 Unscramble words to win XP! Solo or duel a friend.')
    .addSubcommand(sub =>
      sub.setName('solo')
        .setDescription(`Play ${SOLO_ROUNDS} rounds solo for XP rewards.`)
    )
    .addSubcommand(sub =>
      sub.setName('duel')
        .setDescription(`Challenge someone to a ${DUEL_ROUNDS}-round scramble duel.`)
        .addUserOption(o => o.setName('opponent').setDescription('Who to duel').setRequired(true))
        .addIntegerOption(o => o.setName('wager').setDescription('XP wager (min 10)').setMinValue(10).setRequired(true))
    ),

  async execute(interaction, client) {
    await interaction.deferReply();

    const sub       = interaction.options.getSubcommand();
    const channelId = interaction.channel.id;
    const guildId   = interaction.guildId;
    const userId    = interaction.user.id;

    client.activeGames = client.activeGames || new Map();

    if (client.activeGames.has(channelId)) {
      return interaction.editReply({ embeds: [errEmbed('A game is already active in this channel!')] });
    }

    // ── SOLO ─────────────────────────────────────────────────────────────────
    if (sub === 'solo') {
      const gameState = {
        type:       'scramble-solo',
        channelId,  guildId,
        hostId:     userId,
        round:      0,
        totalRounds: SOLO_ROUNDS,
        score:      0,
        usedWords:  new Set(),
        active:     true,
        currentWord: null,
        roundTimer:  null,
      };
      client.activeGames.set(channelId, gameState);

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5B8FFF)
            .setTitle('🔤 Scramble — Solo Mode')
            .setDescription(
              `**${SOLO_ROUNDS} rounds** · **${ROUND_TIME / 1000}s** per word\n\n` +
              `Unscramble each word as fast as you can!\n` +
              `Harder words = more XP.\n\n` +
              `Starting in **3 seconds...**`
            )
            .setTimestamp(),
        ],
      });

      await sleep(3000);
      await runScrambleRound(gameState, interaction.channel, client, null);
      return;
    }

    // ── DUEL ─────────────────────────────────────────────────────────────────
    if (sub === 'duel') {
      const opponent = interaction.options.getUser('opponent');
      const wager    = interaction.options.getInteger('wager');

      if (opponent.id === userId) return interaction.editReply({ embeds: [errEmbed("You can't duel yourself!")] });
      if (opponent.bot)           return interaction.editReply({ embeds: [errEmbed("You can't duel a bot!")] });

      const challengerData = db.getUser(userId, guildId);
      const opponentData   = db.getUser(opponent.id, guildId);

      if (challengerData.xp < wager) return interaction.editReply({ embeds: [errEmbed(`You only have **${challengerData.xp.toLocaleString()} XP**.`)] });
      if (opponentData.xp < wager)   return interaction.editReply({ embeds: [errEmbed(`${opponent.username} only has **${opponentData.xp.toLocaleString()} XP**.`)] });

      // Register pending scramble duel
      client.pendingScrambles = client.pendingScrambles || new Map();
      client.pendingScrambles.set(`${guildId}-${opponent.id}`, {
        channelId, guildId,
        challenger: userId,
        opponent:   opponent.id,
        wager,
        createdAt:  Date.now(),
      });

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xFF6B35)
            .setTitle('🔤 Scramble Duel Challenge!')
            .setDescription(
              `<@${userId}> challenges ${opponent} to a **Scramble Duel**!\n\n` +
              `**${DUEL_ROUNDS} rounds** · **${ROUND_TIME / 1000}s** per word · **Wager: ${wager.toLocaleString()} XP**\n\n` +
              `${opponent}, type \`/scramble accept\` within **2 minutes** to play!`
            )
            .addFields(
              { name: '🗡️ Challenger', value: `<@${userId}> · Lv.${challengerData.level} · ${challengerData.xp.toLocaleString()} XP`, inline: true },
              { name: '🛡️ Opponent',   value: `${opponent} · Lv.${opponentData.level} · ${opponentData.xp.toLocaleString()} XP`,    inline: true },
            )
            .setTimestamp(),
        ],
      });

      // Auto-expire pending duel after 2 min
      setTimeout(() => {
        const key = `${guildId}-${opponent.id}`;
        if (client.pendingScrambles && client.pendingScrambles.has(key)) {
          const p = client.pendingScrambles.get(key);
          if (p.challenger === userId) client.pendingScrambles.delete(key);
        }
      }, 120_000);

      return;
    }
  },
};

// ─── Accept subcommand — separate export handled via index interaction ────────
// We handle /scramble accept via a dedicated accept subcommand below

module.exports.data.addSubcommand(sub =>
  sub.setName('accept').setDescription('Accept an incoming scramble duel challenge.')
);

// Augment execute to handle accept
const originalExecute = module.exports.execute;
module.exports.execute = async function(interaction, client) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'accept') {
    await interaction.deferReply();

    const guildId   = interaction.guildId;
    const userId    = interaction.user.id;
    const channelId = interaction.channel.id;

    client.pendingScrambles = client.pendingScrambles || new Map();
    const key     = `${guildId}-${userId}`;
    const pending = client.pendingScrambles.get(key);

    if (!pending) return interaction.editReply({ embeds: [errEmbed("You don't have a pending scramble challenge.")] });
    if (Date.now() - pending.createdAt > 120_000) {
      client.pendingScrambles.delete(key);
      return interaction.editReply({ embeds: [errEmbed('That challenge has expired.')] });
    }

    client.pendingScrambles.delete(key);
    client.activeGames = client.activeGames || new Map();

    if (client.activeGames.has(channelId)) {
      return interaction.editReply({ embeds: [errEmbed('A game is already active in this channel!')] });
    }

    const challengerData = db.getUser(pending.challenger, guildId);
    const opponentData   = db.getUser(userId, guildId);

    if (challengerData.xp < pending.wager || opponentData.xp < pending.wager) {
      return interaction.editReply({ embeds: [errEmbed('One of you no longer has enough XP. Duel cancelled.')] });
    }

    const gameState = {
      type:        'scramble-duel',
      channelId,   guildId,
      challenger:  pending.challenger,
      opponent:    userId,
      wager:       pending.wager,
      round:       0,
      totalRounds: DUEL_ROUNDS,
      scores:      { [pending.challenger]: 0, [userId]: 0 },
      usedWords:   new Set(),
      active:      true,
      currentWord: null,
      roundTimer:  null,
    };

    client.activeGames.set(channelId, gameState);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xFFD700)
          .setTitle('🔤 Scramble Duel — Accepted!')
          .setDescription(
            `<@${pending.challenger}> vs <@${userId}>\n\n` +
            `**${DUEL_ROUNDS} rounds · ${ROUND_TIME / 1000}s per word · Wager: ${pending.wager.toLocaleString()} XP**\n\n` +
            `Starting in **3 seconds...**`
          )
          .setTimestamp(),
      ],
    });

    await sleep(3000);
    await runScrambleRound(gameState, interaction.channel, client, null);
    return;
  }

  return originalExecute(interaction, client);
};

// ─── Round Runner ─────────────────────────────────────────────────────────────

async function runScrambleRound(gameState, channel, client, _prevMsg) {
  gameState.round++;
  const { round, totalRounds } = gameState;

  if (round > totalRounds || !gameState.active) {
    await endScramble(gameState, channel, client);
    return;
  }

  const word       = pickWord(gameState.usedWords);
  gameState.usedWords.add(word);
  gameState.currentWord = word;

  const scrambled  = scramble(word);
  const diff       = getDifficulty(word);
  const isSolo     = gameState.type === 'scramble-solo';

  const roundMsg = await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5B8FFF)
        .setTitle(`🔤 Round ${round} of ${totalRounds}`)
        .setDescription(`# \`${scrambled.toUpperCase()}\``)
        .addFields(
          { name: 'Difficulty', value: diff.label,                    inline: true },
          { name: 'XP Bonus',   value: `×${diff.bonus} multiplier`,   inline: true },
          { name: 'Letters',    value: `${word.length} letters`,       inline: true },
          isSolo
            ? { name: '🏆 Your Score', value: `**${gameState.score} pts**`, inline: false }
            : {
                name: '📊 Scores',
                value: `<@${gameState.challenger}> **${gameState.scores[gameState.challenger]}** pts  ·  <@${gameState.opponent}> **${gameState.scores[gameState.opponent]}** pts`,
                inline: false,
              }
        )
        .setFooter({ text: `⏱️ ${ROUND_TIME / 1000}s to answer · Type the unscrambled word in chat` })
        .setTimestamp(),
    ],
  });

  gameState.roundMsg = roundMsg;

  // Auto-skip round if no answer
  gameState.roundTimer = setTimeout(async () => {
    if (!gameState.active || gameState.currentWord !== word) return;
    gameState.currentWord = null;

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x95A5A6)
          .setTitle(`⏱️ Round ${round} — Time's Up!`)
          .setDescription(`The word was **${word}**. No one got it!`)
          .setTimestamp(),
      ],
    }).catch(() => {});

    await sleep(1500);
    await runScrambleRound(gameState, channel, client, null);
  }, ROUND_TIME);
}

async function endScramble(gameState, channel, client) {
  client.activeGames.delete(gameState.channelId);
  const isSolo = gameState.type === 'scramble-solo';

  if (isSolo) {
    const xpEarned = gameState.score * 5; // 5 XP per point
    const member   = await channel.guild.members.fetch(gameState.hostId).catch(() => null);

    if (member) {
      db.addXp(gameState.hostId, gameState.guildId, xpEarned);
    }

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5B8FFF)
          .setTitle('🔤 Scramble Complete!')
          .setDescription(
            `<@${gameState.hostId}> finished with **${gameState.score} points**!\n\n` +
            `🎉 **+${xpEarned.toLocaleString()} XP** earned!`
          )
          .setFooter({ text: 'Each point = 5 XP · Harder words = more points' })
          .setTimestamp(),
      ],
    }).catch(() => {});
    return;
  }

  // Duel result
  const { challenger, opponent, wager, scores, guildId } = gameState;
  const chalScore = scores[challenger] || 0;
  const oppScore  = scores[opponent]   || 0;
  const isTie     = chalScore === oppScore;

  let desc, newlyUnlocked = [];
  if (isTie) {
    desc = `🤝 **It's a tie!** Both scored **${chalScore} points**. No XP transferred.`;
  } else {
    const winnerId = chalScore > oppScore ? challenger : opponent;
    const loserId  = winnerId === challenger ? opponent : challenger;
    const { actualWager } = db.recordDuelResult(guildId, winnerId, loserId, wager);
    desc = `🏆 **<@${winnerId}> wins!** They take **${actualWager.toLocaleString()} XP** from <@${loserId}>!`;
    newlyUnlocked = checkAndUnlock(winnerId, guildId);
  }

  const embeds = [
    new EmbedBuilder()
      .setColor(isTie ? 0x95A5A6 : 0xFFD700)
      .setTitle('🔤 Scramble Duel Over!')
      .setDescription(desc)
      .addFields(
        { name: `<@${challenger}>`, value: `**${chalScore} points**`, inline: true },
        { name: `<@${opponent}>`,   value: `**${oppScore} points**`,  inline: true },
      )
      .setFooter({ text: `Wager: ${wager.toLocaleString()} XP` })
      .setTimestamp(),
  ];

  for (const ach of newlyUnlocked) {
    embeds.push(
      new EmbedBuilder()
        .setColor(TIER_COLORS[ach.tier] || 0xFFD700)
        .setTitle('🎖️ Achievement Unlocked!')
        .setDescription(`**${ach.emoji} ${ach.name}**\n*${ach.desc}*`)
        .setFooter({ text: `${ach.tier} Tier` })
    );
  }

  await channel.send({ embeds }).catch(() => {});
}

// Export helpers for index.js
module.exports.handleScrambleMessage = async function(gameState, userId, content, channel, client) {
  if (!gameState.active || !gameState.currentWord) return false;

  const isDuel = gameState.type === 'scramble-duel';
  if (isDuel && userId !== gameState.challenger && userId !== gameState.opponent) return false;
  if (!isDuel && userId !== gameState.hostId) return false;

  const answer = content.trim().toLowerCase();
  if (answer !== gameState.currentWord) return false;

  // Correct answer
  clearTimeout(gameState.roundTimer);
  const word = gameState.currentWord;
  gameState.currentWord = null;

  const diff = getDifficulty(word);
  const pts  = diff.bonus * word.length;

  if (isDuel) {
    gameState.scores[userId] = (gameState.scores[userId] || 0) + pts;
  } else {
    gameState.score += pts;
  }

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x4ade80)
        .setTitle(`✅ Round ${gameState.round} — Correct!`)
        .setDescription(
          `<@${userId}> got it! The word was **${word}**.\n` +
          `**+${pts} points** (${diff.label})`
        )
        .setTimestamp(),
    ],
  }).catch(() => {});

  await sleep(1200);
  await runScrambleRound(gameState, channel, client, null);
  return true;
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function errEmbed(msg) {
  return new EmbedBuilder().setColor(0xE74C3C).setTitle('❌ Error').setDescription(msg).setTimestamp();
}