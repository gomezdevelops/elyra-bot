// src/commands/reaction-race.js
// Server-wide reaction race — bot posts an emoji sequence, first to type it exactly wins XP.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');

const RACE_DURATION = 20_000; // 20s to type the sequence

// Pool of common emojis that are typeable as :name:
const EMOJI_POOL = [
  '🔥', '⚡', '🌊', '🎯', '💎', '🌙', '⭐', '🎲',
  '🏆', '🎮', '🚀', '💥', '🌈', '🎸', '🦋', '🌺',
  '🍀', '🎪', '🔮', '🦊', '🐉', '🌸', '💫', '🎭',
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reaction-race')
    .setDescription('🔥 Race to type the emoji sequence first and win XP!')
    .addIntegerOption(o =>
      o.setName('reward').setDescription('XP reward for the winner (default 100)').setMinValue(10).setMaxValue(2000).setRequired(false)
    ),

  async execute(interaction, client) {
    await interaction.deferReply();

    const channel   = interaction.channel;
    const channelId = channel.id;
    const guildId   = interaction.guildId;
    const reward    = interaction.options.getInteger('reward') ?? 100;

    // Block if a race/scramble already active in this channel
    client.activeGames = client.activeGames || new Map();
    if (client.activeGames.has(channelId)) {
      return interaction.editReply({ embeds: [errEmbed('A game is already active in this channel!')] });
    }

    // Generate sequence of 4–6 random emojis
    const length   = 4 + Math.floor(Math.random() * 3); // 4, 5, or 6
    const sequence = Array.from({ length }, () =>
      EMOJI_POOL[Math.floor(Math.random() * EMOJI_POOL.length)]
    );
    const sequenceStr = sequence.join(' ');

    // Register game
    const gameState = {
      type:      'reaction-race',
      channelId,
      guildId,
      sequence:  sequenceStr,
      reward,
      startedAt: null,
      active:    false,
      hostId:    interaction.user.id,
    };
    client.activeGames.set(channelId, gameState);

    // Countdown embed
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xFF6B35)
          .setTitle('⚡ Reaction Race Starting!')
          .setDescription(
            `Get ready! An emoji sequence will appear in **3 seconds**.\n\n` +
            `Be the **first** to type it exactly to win **${reward.toLocaleString()} XP**!\n\n` +
            `*Tip: copy-paste counts — speed is everything.*`
          )
          .setFooter({ text: `Started by ${interaction.user.displayName} · You have ${RACE_DURATION / 1000}s once it appears` })
          .setTimestamp(),
      ],
    });

    await sleep(3000);

    if (!client.activeGames.has(channelId)) return; // cancelled

    gameState.active    = true;
    gameState.startedAt = Date.now();

    // Post the sequence
    const raceMsg = await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xFFD700)
          .setTitle('⚡ TYPE THIS NOW!')
          .setDescription(`# ${sequenceStr}`)
          .setFooter({ text: `⏱️ ${RACE_DURATION / 1000} seconds · First correct answer wins ${reward.toLocaleString()} XP` })
          .setTimestamp(),
      ],
    });

    gameState.raceMsg = raceMsg;

    // Auto-expire
    setTimeout(async () => {
      if (!client.activeGames.has(channelId)) return;
      const gs = client.activeGames.get(channelId);
      if (!gs || !gs.active) return;
      client.activeGames.delete(channelId);

      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x95A5A6)
            .setTitle('⚡ Race Over — No Winner!')
            .setDescription(`Nobody typed the sequence in time.\nThe answer was: ${sequenceStr}`)
            .setTimestamp(),
        ],
      }).catch(() => {});
    }, RACE_DURATION);
  },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function errEmbed(msg) {
  return new EmbedBuilder().setColor(0xE74C3C).setTitle('❌ Error').setDescription(msg).setTimestamp();
}