// src/commands/achievements.js
// Shows all achievements — unlocked (with date) and locked (with progress bar).

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { ACHIEVEMENTS, TIER_COLORS, TIER_ORDER, getUserAchievementSummary } = require('../utils/achievements');

function buildMiniBar(current, target, length = 10) {
  const filled = Math.round((current / target) * length);
  return '▰'.repeat(Math.max(0, Math.min(length, filled))) + '▱'.repeat(Math.max(0, length - filled));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('achievements')
    .setDescription('🎖️ View all achievements and your progress.')
    .addUserOption(o => o.setName('user').setDescription('User to check (defaults to you)').setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply();

    const target  = interaction.options.getUser('user') ?? interaction.user;
    const guildId = interaction.guildId;
    const userData = db.getUser(target.id, guildId);

    const { unlocked, locked, total, unlockedCount } = getUserAchievementSummary(target.id, guildId);
    const unlockedIds = new Set(unlocked.map(a => a.id));

    // Group all achievements by tier, in order, marking unlocked status
    const embeds = [];

    const overallPct = Math.floor((unlockedCount / total) * 100);
    const overviewBar = buildMiniBar(unlockedCount, total, 20);

    embeds.push(
      new EmbedBuilder()
        .setColor(0xFFD700)
        .setAuthor({
          name:    `${target.username}'s Achievements`,
          iconURL: target.displayAvatarURL({ dynamic: true }),
        })
        .setDescription(
          `**${unlockedCount} / ${total}** achievements unlocked (${overallPct}%)\n` +
          `\`${overviewBar}\``
        )
        .setTimestamp()
    );

    for (const tier of TIER_ORDER) {
      const tierAchievements = ACHIEVEMENTS.filter(a => a.tier === tier);
      if (!tierAchievements.length) continue;

      const lines = tierAchievements.map(ach => {
        const isUnlocked = unlockedIds.has(ach.id);

        if (isUnlocked) {
          const unlockedData = unlocked.find(a => a.id === ach.id);
          return `✅ ${ach.emoji} **${ach.name}** — *${ach.desc}*`;
        }

        // Locked — show progress if available
        if (ach.progress) {
          const { current, target: t } = ach.progress(userData);
          const bar = buildMiniBar(current, t, 10);
          return `🔒 ${ach.emoji} **${ach.name}** — *${ach.desc}*\n　 \`${bar}\` ${current.toLocaleString()}/${t.toLocaleString()}`;
        }

        return `🔒 ${ach.emoji} **${ach.name}** — *${ach.desc}*`;
      });

      embeds.push(
        new EmbedBuilder()
          .setColor(TIER_COLORS[tier])
          .setTitle(`${tierIcon(tier)} ${tier} Tier`)
          .setDescription(lines.join('\n\n'))
      );
    }

    // Discord allows max 10 embeds per message — we have 1 (overview) + up to 4 (tiers) = 5, safe
    await interaction.editReply({ embeds });
  },
};

function tierIcon(tier) {
  const icons = { Bronze: '🥉', Silver: '🥈', Gold: '🥇', Platinum: '💠' };
  return icons[tier] || '🎖️';
}