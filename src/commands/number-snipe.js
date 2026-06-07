// src/commands/number-snipe.js
// Number Snipe — host picks player count, all players guess 1-100,
// closest to the secret number wins XP from the pot.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ComponentType,
} = require('discord.js');
const db = require('../database');

const GUESS_TIME    = 60_000; // 60s to submit all guesses once game starts
const JOIN_TIME     = 60_000; // 60s lobby window

module.exports = {
  data: new SlashCommandBuilder()
    .setName('number-snipe')
    .setDescription('🎯 Guess the secret number — closest player wins the XP pot!')
    .addIntegerOption(o =>
      o.setName('players')
        .setDescription('How many players (2–10)')
        .setMinValue(2)
        .setMaxValue(10)
        .setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName('entry-fee')
        .setDescription('XP each player puts in the pot (default 50)')
        .setMinValue(10)
        .setMaxValue(5000)
        .setRequired(false)
    ),

  async execute(interaction, client) {
    await interaction.deferReply();

    const channelId   = interaction.channel.id;
    const guildId     = interaction.guildId;
    const hostId      = interaction.user.id;
    const maxPlayers  = interaction.options.getInteger('players');
    const entryFee    = interaction.options.getInteger('entry-fee') ?? 50;

    client.activeGames = client.activeGames || new Map();

    if (client.activeGames.has(channelId)) {
      return interaction.editReply({ embeds: [errEmbed('A game is already active in this channel!')] });
    }

    // Check host has enough XP
    const hostData = db.getUser(hostId, guildId);
    if (hostData.xp < entryFee) {
      return interaction.editReply({ embeds: [errEmbed(`You need **${entryFee} XP** to start but only have **${hostData.xp.toLocaleString()}**.`)] });
    }

    const gameState = {
      type:       'number-snipe',
      channelId,  guildId,
      hostId,
      maxPlayers,
      entryFee,
      players:    new Map(), // userId → { guess: null, xp: n }
      guesses:    new Map(), // userId → number
      phase:      'lobby',   // lobby → guessing → revealed
      active:     true,
      lobbyMsg:   null,
      secretNum:  null,
    };

    // Host auto-joins
    gameState.players.set(hostId, { guess: null });
    client.activeGames.set(channelId, gameState);

    // ── Lobby phase ───────────────────────────────────────────────────────
    const joinBtn = new ButtonBuilder()
      .setCustomId(`snipe-join-${channelId}`)
      .setLabel('Join Game')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🎯');

    const row = new ActionRowBuilder().addComponents(joinBtn);

    const lobbyEmbed = () => new EmbedBuilder()
      .setColor(0x5B8FFF)
      .setTitle('🎯 Number Snipe — Lobby')
      .setDescription(
        `A secret number between **1 and 100** will be chosen.\n` +
        `Every player guesses — **closest wins the entire pot!**\n\n` +
        `**Entry Fee:** ${entryFee.toLocaleString()} XP each\n` +
        `**Pot Size:** ${(gameState.players.size * entryFee).toLocaleString()} XP\n\n` +
        `**Players (${gameState.players.size}/${maxPlayers}):**\n` +
        [...gameState.players.keys()].map(id => `• <@${id}>`).join('\n')
      )
      .setFooter({ text: `Click Join to enter · Starts when ${maxPlayers} players join or host uses /number-snipe start` })
      .setTimestamp();

    const lobbyMsg = await interaction.editReply({
      embeds: [lobbyEmbed()],
      components: [row],
    });
    gameState.lobbyMsg = lobbyMsg;

    // Button collector for joining
    const collector = lobbyMsg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: JOIN_TIME,
    });

    collector.on('collect', async btn => {
      if (btn.customId !== `snipe-join-${channelId}`) return;

      const joinerId = btn.user.id;

      if (gameState.players.has(joinerId)) {
        return btn.reply({ content: "You're already in!", ephemeral: true });
      }

      const joinerData = db.getUser(joinerId, guildId);
      if (joinerData.xp < entryFee) {
        return btn.reply({ content: `You need **${entryFee} XP** to join but only have **${joinerData.xp.toLocaleString()}**.`, ephemeral: true });
      }

      gameState.players.set(joinerId, { guess: null });
      await btn.update({ embeds: [lobbyEmbed()], components: [row] });

      // Auto-start when full
      if (gameState.players.size >= maxPlayers) {
        collector.stop('full');
      }
    });

    collector.on('end', async (_, reason) => {
      if (!gameState.active) return;

      if (gameState.players.size < 2) {
        client.activeGames.delete(channelId);
        await interaction.channel.send({
          embeds: [errEmbed('Not enough players joined. Game cancelled.')],
        }).catch(() => {});
        return;
      }

      await startSnipeGame(gameState, interaction.channel, client);
    });

    // Auto-start after JOIN_TIME regardless
    setTimeout(async () => {
      if (gameState.phase !== 'lobby') return;
      collector.stop('timeout');
    }, JOIN_TIME);
  },
};

async function startSnipeGame(gameState, channel, client) {
  gameState.phase     = 'guessing';
  gameState.secretNum = 1 + Math.floor(Math.random() * 100);

  // Deduct entry fees
  for (const [userId] of gameState.players) {
    db.addXp(userId, gameState.guildId, -gameState.entryFee);
  }

  const potTotal = gameState.players.size * gameState.entryFee;

  // Update lobby message — disable join button
  if (gameState.lobbyMsg) {
    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('snipe-closed')
        .setLabel('Game Started')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );
    await gameState.lobbyMsg.edit({ components: [disabledRow] }).catch(() => {});
  }

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle('🎯 Number Snipe — GUESS NOW!')
        .setDescription(
          `The secret number has been chosen!\n\n` +
          `**All ${gameState.players.size} players** — use \`/number-snipe guess <number>\` to submit your guess.\n\n` +
          `🏆 **Pot: ${potTotal.toLocaleString()} XP**\n` +
          `⏱️ You have **${GUESS_TIME / 1000} seconds** to guess.`
        )
        .addFields({
          name: 'Players',
          value: [...gameState.players.keys()].map(id => `• <@${id}> — ⏳ waiting`).join('\n'),
        })
        .setFooter({ text: 'Closest guess wins. Ties split the pot.' })
        .setTimestamp(),
    ],
  });

  // Auto-reveal after GUESS_TIME
  setTimeout(() => {
    if (gameState.phase !== 'guessing') return;
    revealResults(gameState, channel, client);
  }, GUESS_TIME);
}

async function revealResults(gameState, channel, client) {
  if (gameState.phase === 'revealed') return;
  gameState.phase  = 'revealed';
  gameState.active = false;
  client.activeGames.delete(gameState.channelId);

  const secret  = gameState.secretNum;
  const potTotal = gameState.players.size * gameState.entryFee;

  // Build results — only players who guessed
  const results = [];
  for (const [userId] of gameState.players) {
    const guess = gameState.guesses.get(userId);
    results.push({
      userId,
      guess:    guess ?? null,
      distance: guess != null ? Math.abs(guess - secret) : Infinity,
    });
  }

  results.sort((a, b) => a.distance - b.distance);

  // Find winners (could be ties at same distance)
  const minDist   = results[0].distance;
  const winners   = results.filter(r => r.distance === minDist && r.guess != null);
  const xpPerWinner = winners.length > 0 ? Math.floor(potTotal / winners.length) : 0;

  // Award XP to winners
  for (const w of winners) {
    db.addXp(w.userId, gameState.guildId, xpPerWinner);
  }

  // Build results display
  const resultLines = results.map((r, i) => {
    const isWinner = winners.some(w => w.userId === r.userId);
    const medal    = isWinner ? '🏆' : `${i + 1}.`;
    const guessStr = r.guess != null ? `guessed **${r.guess}** (off by ${r.distance})` : '*no guess*';
    return `${medal} <@${r.userId}> — ${guessStr}`;
  });

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle('🎯 Number Snipe — Results!')
        .setDescription(
          `🔢 The secret number was **${secret}**!\n\n` +
          (winners.length > 0
            ? `🏆 **Winner${winners.length > 1 ? 's' : ''}:** ${winners.map(w => `<@${w.userId}>`).join(', ')} — **+${xpPerWinner.toLocaleString()} XP each!**\n\n`
            : `💀 Nobody guessed! Pot lost.\n\n`) +
          resultLines.join('\n')
        )
        .setFooter({ text: `Pot: ${potTotal.toLocaleString()} XP total` })
        .setTimestamp(),
    ],
  }).catch(() => {});
}

// Export for interaction handler (guess subcommand handled in index)
module.exports.handleGuess   = handleGuess;
module.exports.revealResults = revealResults;
module.exports.startSnipeGame = startSnipeGame;

async function handleGuess(gameState, userId, guess, channel) {
  if (gameState.phase !== 'guessing')        return 'not_guessing';
  if (!gameState.players.has(userId))        return 'not_player';
  if (gameState.guesses.has(userId))         return 'already_guessed';
  if (guess < 1 || guess > 100)              return 'out_of_range';

  gameState.guesses.set(userId, guess);

  // Check if everyone guessed
  const allGuessed = [...gameState.players.keys()].every(id => gameState.guesses.has(id));
  return allGuessed ? 'all_done' : 'ok';
}

// Guess subcommand — added here and handled via index.js interaction routing
module.exports.data.addSubcommand(sub =>
  sub.setName('guess')
    .setDescription('Submit your guess for the active Number Snipe game.')
    .addIntegerOption(o =>
      o.setName('number')
        .setDescription('Your guess (1–100)')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true)
    )
);

const originalExecute = module.exports.execute;
module.exports.execute = async function(interaction, client) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'guess') {
    await interaction.deferReply({ ephemeral: true });

    const channelId = interaction.channel.id;
    const userId    = interaction.user.id;
    const guess     = interaction.options.getInteger('number');

    client.activeGames = client.activeGames || new Map();
    const gameState = client.activeGames.get(channelId);

    if (!gameState || gameState.type !== 'number-snipe') {
      return interaction.editReply({ content: '❌ No active Number Snipe game in this channel.' });
    }

    const result = await handleGuess(gameState, userId, guess, interaction.channel);

    if (result === 'not_player')      return interaction.editReply({ content: "❌ You're not in this game." });
    if (result === 'already_guessed') return interaction.editReply({ content: '❌ You already submitted a guess!' });
    if (result === 'not_guessing')    return interaction.editReply({ content: '❌ The game is not in the guessing phase.' });

    await interaction.editReply({ content: `✅ Your guess of **${guess}** has been locked in!` });

    // Update channel message with who has guessed (no spoilers)
    const guessedCount = gameState.guesses.size;
    const totalCount   = gameState.players.size;

    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5B8FFF)
          .setTitle('🎯 Guess Received!')
          .setDescription(
            `<@${userId}> has locked in their guess!\n\n` +
            `**${guessedCount}/${totalCount}** players have guessed.` +
            (guessedCount === totalCount ? '\n\n🎲 All guesses in — revealing now!' : '')
          )
          .setTimestamp(),
      ],
    }).catch(() => {});

    // All guessed — reveal immediately
    if (result === 'all_done') {
      await revealResults(gameState, interaction.channel, client);
    }

    return;
  }

  return originalExecute(interaction, client);
};

function errEmbed(msg) {
  return new EmbedBuilder().setColor(0xE74C3C).setTitle('❌ Error').setDescription(msg).setTimestamp();
}