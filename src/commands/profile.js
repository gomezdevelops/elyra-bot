// src/commands/profile.js
// Rich embed profile card — sections for level, duels, streaks, achievements.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { getLevelColor } = require('../utils/xpHandler');
const { getUserAchievementSummary } = require('../utils/achievements');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('📋 View a detailed profile card.')
    .addUserOption(o => o.setName('user').setDescription('User to view (defaults to you)').setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply();

    const target  = interaction.options.getUser('user') ?? interaction.user;
    const guildId = interaction.guildId;
    const member  = await interaction.guild.members.fetch(target.id).catch(() => null);

    const userData = db.getUser(target.id, guildId);
    const rank      = db.getUserRank(target.id, guildId);
    const { current, needed } = db.getProgress(userData.xp, userData.level);
    const bar       = db.buildProgressBar(current, needed, 18);
    const pct       = Math.floor((current / needed) * 100);

    const wins    = userData.duel_wins   || 0;
    const losses  = userData.duel_losses || 0;
    const total   = wins + losses;
    const winRate = total > 0 ? Math.floor((wins / total) * 100) : 0;

    const { unlocked, total: totalAch } = getUserAchievementSummary(target.id, guildId);

    // Top 5 most recent achievements (or all if fewer)
    const achievementIcons = unlocked.length > 0
      ? unlocked.slice(0, 8).map(a => a.emoji).join(' ')
      : '*No achievements yet — use `/achievements` to see what you can unlock!*';

    const embed = new EmbedBuilder()
      .setColor(getLevelColor(userData.level))
      .setAuthor({
        name:    `${member ? member.displayName : target.username}'s Profile`,
        iconURL: target.displayAvatarURL({ dynamic: true }),
      })
      .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 256 }));

    if (userData.title) {
      embed.setDescription(`*"${userData.title}"*`);
    }

    embed.addFields(
      // ── Section: Level & XP ──────────────────────────────
      { name: '\u200b', value: '**📈 ── LEVEL & EXPERIENCE ── 📈**' },
      { name: '⭐ Level',      value: `**${userData.level}**`,                  inline: true },
      { name: '🏅 Server Rank', value: `**#${rank ?? '—'}**`,                   inline: true },
      { name: '✨ Total XP',   value: `**${userData.xp.toLocaleString()}**`,    inline: true },
      {
        name:  `Progress to Level ${userData.level + 1} — ${pct}%`,
        value: `\`${bar}\`\n**${current.toLocaleString()} / ${needed.toLocaleString()} XP** · ${(needed - current).toLocaleString()} XP remaining`,
      },

      // ── Section: Combat ───────────────────────────────────
      { name: '\u200b', value: '**⚔️ ── DUEL RECORD ── ⚔️**' },
      { name: '🏆 Wins',      value: `**${wins}**`,     inline: true },
      { name: '💀 Losses',    value: `**${losses}**`,   inline: true },
      { name: '📊 Win Rate',  value: `**${winRate}%**`, inline: true },

      // ── Section: Activity ─────────────────────────────────
      { name: '\u200b', value: '**🔥 ── DAILY ACTIVITY ── 🔥**' },
      { name: 'Current Streak', value: `**${userData.daily_streak || 0}** / 7 days`, inline: true },
      { name: 'Equipped Title', value: userData.title ? `*"${userData.title}"*` : '*None equipped*', inline: true },

      // ── Section: Achievements ─────────────────────────────
      { name: '\u200b', value: '**🎖️ ── ACHIEVEMENTS ── 🎖️**' },
      { name: `Unlocked (${unlocked.length}/${totalAch})`, value: achievementIcons },
    );

    embed
      .setFooter({ text: `Use /achievements to see all achievement progress` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};