/**
 * Curated catalog of PalWorldSettings.ini options exposed in the web UI.
 *
 * Whitelist model: only keys listed here are ever shown to or accepted from
 * the client. Everything else in the file (server name, passwords, ports,
 * REST API, crossplay tuple, ...) is preserved verbatim and can never be
 * changed through the UI.
 */

export const CATEGORIES = [
  { id: 'rates', label: 'Rates & Multipliers' },
  { id: 'world', label: 'World & Base' },
  { id: 'difficulty', label: 'Difficulty & Death' },
  { id: 'features', label: 'Features' },
  { id: 'performance', label: 'Performance & Capacity' },
];

// Operational/credential keys. Redundant with the whitelist above, but kept as
// an explicit guard so a catalog mistake can never expose one of these.
export const EXCLUDED_KEYS = new Set([
  'ServerName',
  'ServerDescription',
  'AdminPassword',
  'ServerPassword',
  'PublicIP',
  'PublicPort',
  'RCONEnabled',
  'RCONPort',
  'RESTAPIEnabled',
  'RESTAPIPort',
  'bUseAuth',
  'Region',
  'BanListURL',
  'LogFormatType',
  'bIsUseBackupSaveData',
  'CoopPlayerMaxNum',
  'CrossplayPlatforms',
  'bShowPlayerList',
]);

const rate = (key, label, description, extra = {}) => ({
  key,
  label,
  description,
  type: 'float',
  min: 0.1,
  max: 5,
  step: 0.1,
  default: 1,
  category: 'rates',
  ...extra,
});

const flag = (key, label, description, def, category = 'features') => ({
  key,
  label,
  description,
  type: 'bool',
  default: def,
  category,
});

export const CATALOG = [
  // ── Rates & Multipliers ────────────────────────────────────────────────────
  rate('ExpRate', 'EXP Rate', 'Multiplier for experience gained by players and Pals.', { max: 20 }),
  rate('PalCaptureRate', 'Pal Capture Rate', 'Multiplier for Pal Sphere capture chance.', { min: 0.5, max: 2 }),
  rate('PalSpawnNumRate', 'Pal Spawn Number', 'Multiplier for how many Pals spawn in the world.', { min: 0.5, max: 3 }),
  rate('PalDamageRateAttack', 'Pal Attack Damage', 'Damage dealt by Pals.'),
  rate('PalDamageRateDefense', 'Pal Damage Taken', 'Damage taken by Pals (higher = squishier Pals).'),
  rate('PlayerDamageRateAttack', 'Player Attack Damage', 'Damage dealt by players.'),
  rate('PlayerDamageRateDefense', 'Player Damage Taken', 'Damage taken by players (higher = harder).'),
  rate('PlayerStomachDecreaceRate', 'Player Hunger Drain', 'How fast player hunger depletes.'),
  rate('PlayerStaminaDecreaceRate', 'Player Stamina Drain', 'How fast player stamina depletes.'),
  rate('PlayerAutoHPRegeneRate', 'Player HP Regen', 'Player health regeneration speed.'),
  rate('PlayerAutoHpRegeneRateInSleep', 'Player Sleep HP Regen', 'Player health regeneration speed while sleeping.'),
  rate('PalStomachDecreaceRate', 'Pal Hunger Drain', 'How fast Pal hunger depletes.'),
  rate('PalStaminaDecreaceRate', 'Pal Stamina Drain', 'How fast Pal stamina depletes.'),
  rate('PalAutoHPRegeneRate', 'Pal HP Regen', 'Pal health regeneration speed.'),
  rate('PalAutoHpRegeneRateInSleep', 'Pal Sleep HP Regen', 'Pal health regeneration speed while in the Palbox.'),
  rate('WorkSpeedRate', 'Work Speed', 'Multiplier for base work/crafting speed.'),
  rate('CollectionDropRate', 'Gathering Drop Rate', 'Items dropped when gathering (trees, ore, plants).', { min: 0.5, max: 3 }),
  rate('CollectionObjectHpRate', 'Gatherable HP', 'Health of gatherable objects (higher = slower to harvest).', { min: 0.5, max: 3 }),
  rate('CollectionObjectRespawnSpeedRate', 'Gatherable Respawn Speed', 'Respawn interval multiplier for gatherable objects (higher = slower respawn).', { min: 0.5, max: 3 }),
  rate('EnemyDropItemRate', 'Enemy Drop Rate', 'Items dropped by defeated enemies.', { min: 0.5, max: 3 }),
  rate('ItemWeightRate', 'Item Weight', 'Multiplier for item weight (lower = carry more).'),
  {
    key: 'PalEggDefaultHatchingTime',
    label: 'Egg Hatching Time (hours)',
    description: 'Hours for a huge egg to hatch (other eggs scale down from this). 0 = instant.',
    type: 'float',
    min: 0,
    max: 240,
    step: 1,
    default: 72,
    category: 'rates',
  },

  // ── World & Base ───────────────────────────────────────────────────────────
  rate('DayTimeSpeedRate', 'Day Speed', 'How fast daytime passes.', { category: 'world' }),
  rate('NightTimeSpeedRate', 'Night Speed', 'How fast nighttime passes.', { category: 'world' }),
  {
    key: 'BaseCampCount',
    label: 'Max Base Camps',
    description: 'Maximum number of base camps on the server (across all guilds).',
    type: 'int',
    min: 64,
    max: 512,
    step: 1,
    default: 128,
    category: 'world',
  },
  {
    key: 'BaseCampWorkerMaxNum',
    label: 'Max Workers per Base',
    description: 'Maximum number of Pals working at one base camp.',
    type: 'int',
    min: 1,
    max: 50,
    step: 1,
    default: 15,
    category: 'world',
  },
  {
    key: 'GuildPlayerMaxNum',
    label: 'Max Guild Members',
    description: 'Maximum number of players in one guild.',
    type: 'int',
    min: 1,
    max: 100,
    step: 1,
    default: 20,
    category: 'world',
  },
  flag(
    'bAutoResetGuildNoOnlinePlayers',
    'Auto-reset Inactive Guilds',
    'Automatically reset a guild when no member has been online for the time below.',
    false,
    'world'
  ),
  {
    key: 'AutoResetGuildTimeNoOnlinePlayers',
    label: 'Guild Reset After (hours)',
    description: 'Hours of full-guild inactivity before an automatic reset (needs the toggle above).',
    type: 'float',
    min: 1,
    max: 240,
    step: 1,
    default: 72,
    category: 'world',
  },
  flag(
    'bExistPlayerAfterLogout',
    'Body Stays After Logout',
    'Keep the player character in the world after logging out.',
    false,
    'world'
  ),
  {
    key: 'DropItemAliveMaxHours',
    label: 'Dropped Items Despawn (hours)',
    description: 'How long dropped items stay in the world.',
    type: 'float',
    min: 0.1,
    max: 24,
    step: 0.1,
    default: 1,
    category: 'world',
  },
  rate('BuildObjectDamageRate', 'Structure Damage', 'Damage taken by built structures.', { min: 0.5, max: 3, category: 'world' }),
  {
    key: 'BuildObjectDeteriorationDamageRate',
    label: 'Structure Decay Rate',
    description: 'Weathering/decay speed of structures outside a base. 0 disables decay entirely.',
    type: 'float',
    min: 0,
    max: 10,
    step: 0.1,
    default: 1,
    category: 'world',
  },

  // ── Difficulty & Death ─────────────────────────────────────────────────────
  {
    key: 'Difficulty',
    label: 'Difficulty Preset',
    description: 'Overall difficulty preset. "None" means the individual settings on this page apply.',
    type: 'enum',
    options: ['None', 'Casual', 'Normal', 'Hard'],
    default: 'None',
    category: 'difficulty',
  },
  {
    key: 'DeathPenalty',
    label: 'Death Penalty',
    description: 'What players drop on death.',
    type: 'enum',
    options: ['None', 'Item', 'ItemAndEquipment', 'All'],
    default: 'All',
    category: 'difficulty',
  },
  flag('bHardcore', 'Hardcore Mode', 'Players are permanently lost on death.', false, 'difficulty'),
  flag('bPalLost', 'Pal Permadeath', 'Pals are permanently lost when they die.', false, 'difficulty'),
  flag(
    'bCharacterRecreateInHardcore',
    'Allow Recreate in Hardcore',
    'Allow players to recreate their character after dying in hardcore mode.',
    false,
    'difficulty'
  ),

  // ── Features ───────────────────────────────────────────────────────────────
  flag('bEnableInvaderEnemy', 'Base Raids', 'Enemy groups periodically raid player bases.', true),
  flag('EnablePredatorBossPal', 'Predator Boss Pals', 'Powerful predator Pals roam the world.', true),
  flag('bEnableFastTravel', 'Fast Travel', 'Allow fast travel between Great Eagle statues.', true),
  flag('bIsStartLocationSelectByMap', 'Choose Start Location', 'New players pick their spawn point on the map.', true),
  flag('bEnablePlayerToPlayerDamage', 'PvP Damage', 'Players can damage each other.', false),
  flag('bEnableFriendlyFire', 'Friendly Fire', 'Damage applies within the same guild.', false),
  flag('bEnableDefenseOtherGuildPlayer', 'Defend Against Other Guilds', 'Base Pals fight players from other guilds.', false),
  flag('bInvisibleOtherGuildBaseCampAreaFX', 'Hide Other Guilds’ Base FX', 'Hide the base area effect ring of other guilds.', false),
  flag('bEnableAimAssistPad', 'Aim Assist (Controller)', 'Aim assist for gamepad players.', true),
  flag('bEnableAimAssistKeyboard', 'Aim Assist (Keyboard)', 'Aim assist for mouse & keyboard players.', false),
  flag('bEnableNonLoginPenalty', 'Non-login Penalty', 'Apply penalties (e.g. hunger) to players who stay offline.', true),
  flag('bActiveUNKO', 'Enable UNKO', 'Enable the UNKO item.', false),
  {
    key: 'SupplyDropSpan',
    label: 'Supply Drop Interval (min)',
    description: 'Minutes between meteor/supply drop events.',
    type: 'int',
    min: 30,
    max: 1440,
    step: 5,
    default: 180,
    category: 'features',
  },

  // ── Performance & Capacity ─────────────────────────────────────────────────
  {
    key: 'ServerPlayerMaxNum',
    label: 'Max Players',
    description: 'Maximum number of players that can join the server.',
    type: 'int',
    min: 1,
    max: 32,
    step: 1,
    default: 32,
    category: 'performance',
  },
  {
    key: 'DropItemMaxNum',
    label: 'Max Dropped Items',
    description: 'Maximum dropped items in the world. Lower improves performance.',
    type: 'int',
    min: 0,
    max: 5000,
    step: 100,
    default: 3000,
    category: 'performance',
  },
  {
    key: 'MaxBuildingLimitNum',
    label: 'Building Limit per Player',
    description: 'Maximum structures a single player can build. 0 = unlimited.',
    type: 'int',
    min: 0,
    max: 10000,
    step: 100,
    default: 0,
    category: 'performance',
  },
  {
    key: 'ChatPostLimitPerMinute',
    label: 'Chat Messages per Minute',
    description: 'Per-player chat rate limit.',
    type: 'int',
    min: 1,
    max: 100,
    step: 1,
    default: 10,
    category: 'performance',
  },
];

export const CATALOG_MAP = new Map(CATALOG.map((e) => [e.key, e]));

// Safety net: a catalog entry must never name an excluded key.
for (const e of CATALOG) {
  if (EXCLUDED_KEYS.has(e.key)) {
    throw new Error(`settingsCatalog: "${e.key}" is both cataloged and excluded`);
  }
}

/**
 * Validate one value against its catalog entry.
 * Returns an error string, or null if valid.
 */
export function validateValue(entry, value) {
  switch (entry.type) {
    case 'bool':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'int':
    case 'float': {
      if (typeof value !== 'number' || Number.isNaN(value)) return 'must be a number';
      if (entry.type === 'int' && !Number.isInteger(value)) return 'must be a whole number';
      if (entry.min !== undefined && value < entry.min) return `must be at least ${entry.min}`;
      if (entry.max !== undefined && value > entry.max) return `must be at most ${entry.max}`;
      return null;
    }
    case 'enum':
      return entry.options.includes(value) ? null : `must be one of: ${entry.options.join(', ')}`;
    default:
      return `unsupported type ${entry.type}`;
  }
}
