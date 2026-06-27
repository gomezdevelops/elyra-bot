// src/commands/achievements.js
// Paginated achievements viewer — one tier per page, navigated with buttons.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ComponentType,
} = require('discord.js');
const db = require('../database');
const { ACHIEVEMENTS, TIER_COLORS, TIER_ORDER, getUserAchievementSummary } = require('../utils/achievements');

const PAGE_TIMEOUT = 120_000; // 2 minutes of inactivity before buttons disable

function buildMiniBar(current, target, length = 10) {
  const filled = Math.round((current / target) * length);
  return '▰'.repeat(Math.max(0, Math.min(length, filled))) + '▱'.repeat(Math.max(0, length - filled));
}

function tierIcon(tier) {
  const icons = { Bronze: '🥉', Silver: '🥈', Gold: '🥇', Platinum: '💠' };
  return icons[tier] || '🎖️';
}

/**
 * Build the embed for a single tier page.
 */
function buildTierEmbed(tier, target, userData, unlockedIds, pageIndex, totalPages, unlockedCount, totalAch) {
  const tierAchievements = ACHIEVEMENTS.filter(a => a.tier === tier);

  const lines = tierAchievements.map(ach => {
    const isUnlocked = unlockedIds.has(ach.id);

    if (isUnlocked) {
      return `✅ ${ach.emoji} **${ach.name}** — *${ach.desc}*`;
    }

    if (ach.progress) {
      const { current, target: t } = ach.progress(userData);
      const bar = buildMiniBar(current, t, 10);
      return `🔒 ${ach.emoji} **${ach.name}** — *${ach.desc}*\n　 \`${bar}\` ${current.toLocaleString()}/${t.toLocaleString()}`;
    }

    return `🔒 ${ach.emoji} **${ach.name}** — *${ach.desc}*`;
  });

  const tierUnlockedCount = tierAchievements.filter(a => unlockedIds.has(a.id)).length;

  return new EmbedBuilder()
    .setColor(TIER_COLORS[tier])
    .setAuthor({
      name:    `${target.username}'s Achievements`,
      iconURL: target.displayAvatarURL({ dynamic: true }),
    })
    .setTitle(`${tierIcon(tier)} ${tier} Tier  ·  ${tierUnlockedCount}/${tierAchievements.length}`)
    .setDescription(lines.join('\n\n'))
    .setFooter({
      text: `Page ${pageIndex + 1}/${totalPages} · Overall: ${unlockedCount}/${totalAch} unlocked`,
    });
}

function buildButtons(pageIndex, totalPages, disabled = false) {
  const prevBtn = new ButtonBuilder()
    .setCustomId('ach-prev')
    .setEmoji('◀️')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled || pageIndex === 0);

  const nextBtn = new ButtonBuilder()
    .setCustomId('ach-next')
    .setEmoji('▶️')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled || pageIndex === totalPages - 1);

  const pageIndicator = new ButtonBuilder()
    .setCustomId('ach-page')
    .setLabel(`${pageIndex + 1} / ${totalPages}`)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);

  return new ActionRowBuilder().addComponents(prevBtn, pageIndicator, nextBtn);
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

    const { unlocked, total, unlockedCount } = getUserAchievementSummary(target.id, guildId);
    const unlockedIds = new Set(unlocked.map(a => a.id));

    // Only include tiers that actually have achievements defined
    const tiersWithContent = TIER_ORDER.filter(tier =>
      ACHIEVEMENTS.some(a => a.tier === tier)
    );
    const totalPages = tiersWithContent.length;

    let pageIndex = 0; // start on first tier (Bronze)

    const embed = buildTierEmbed(
      tiersWithContent[pageIndex], target, userData, unlockedIds,
      pageIndex, totalPages, unlockedCount, total
    );
    const row = buildButtons(pageIndex, totalPages);

    const message = await interaction.editReply({ embeds: [embed], components: [row] });

    // ── Button collector ────────────────────────────────────────────────────
    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: PAGE_TIMEOUT,
    });

    collector.on('collect', async (btn) => {
      // Only the person who ran the command can navigate
      if (btn.user.id !== interaction.user.id) {
        return btn.reply({ content: "❌ Only the person who ran this command can navigate.", ephemeral: true });
      }

      if (btn.customId === 'ach-prev' && pageIndex > 0) pageIndex--;
      if (btn.customId === 'ach-next' && pageIndex < totalPages - 1) pageIndex++;

      const newEmbed = buildTierEmbed(
        tiersWithContent[pageIndex], target, userData, unlockedIds,
        pageIndex, totalPages, unlockedCount, total
      );
      const newRow = buildButtons(pageIndex, totalPages);

      await btn.update({ embeds: [newEmbed], components: [newRow] });
    });

    collector.on('end', async () => {
      const disabledRow = buildButtons(pageIndex, totalPages, true);
      await message.edit({ components: [disabledRow] }).catch(() => {});
    });
  },
};