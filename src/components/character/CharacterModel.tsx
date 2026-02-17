/**
 * CharacterModel renders one of 20 CSS character models as JSX divs.
 * Each model is a div structure matching the original robotManager.js templates.
 * Styles come from global CSS in src/styles/characters/*.css.
 */
import type React from 'react';

export type CharacterModelName =
  | 'robot'
  | 'cat'
  | 'alien'
  | 'ghost'
  | 'orb'
  | 'dragon'
  | 'penguin'
  | 'octopus'
  | 'mushroom'
  | 'fox'
  | 'unicorn'
  | 'jellyfish'
  | 'owl'
  | 'bat'
  | 'cactus'
  | 'slime'
  | 'pumpkin'
  | 'yeti'
  | 'crystal'
  | 'bee';

export const CHARACTER_MODEL_NAMES: CharacterModelName[] = [
  'robot',
  'cat',
  'alien',
  'ghost',
  'orb',
  'dragon',
  'penguin',
  'octopus',
  'mushroom',
  'fox',
  'unicorn',
  'jellyfish',
  'owl',
  'bat',
  'cactus',
  'slime',
  'pumpkin',
  'yeti',
  'crystal',
  'bee',
];

// ---------------------------------------------------------------------------
// Individual character bodies
// ---------------------------------------------------------------------------

function RobotBody() {
  return (
    <div className="robot-body-wrap">
      <div className="robot-antenna">
        <div className="robot-antenna-stick" />
        <div className="robot-antenna-ball" />
      </div>
      <div className="robot-head">
        <div className="robot-eye robot-eye-left" />
        <div className="robot-eye robot-eye-right" />
        <div className="robot-mouth" />
      </div>
      <div className="robot-neck" />
      <div className="robot-torso">
        <div className="robot-chest-light" />
        <div className="robot-typing-dots">
          <span /><span /><span />
        </div>
      </div>
    </div>
  );
}

function CatBody() {
  return (
    <div className="robot-body-wrap">
      <div className="cat-head">
        <div className="cat-ear cat-ear-left" />
        <div className="cat-ear cat-ear-right" />
        <div className="cat-eye cat-eye-left" />
        <div className="cat-eye cat-eye-right" />
        <div className="cat-nose" />
        <div className="cat-whisker cat-whisker-left" />
        <div className="cat-whisker cat-whisker-right" />
        <div className="cat-mouth" />
      </div>
      <div className="cat-body">
        <div className="cat-chest-spot" />
      </div>
      <div className="cat-tail" />
    </div>
  );
}

function AlienBody() {
  return (
    <div className="robot-body-wrap">
      <div className="alien-dome">
        <div className="alien-eye" />
        <div className="alien-eye" />
        <div className="alien-eye" />
        <div className="alien-comm-dots">
          <span /><span /><span />
        </div>
      </div>
      <div className="alien-neck" />
      <div className="alien-body">
        <div className="alien-core" />
        <div className="alien-tentacle alien-tentacle-left" />
        <div className="alien-tentacle alien-tentacle-right" />
      </div>
    </div>
  );
}

function GhostBody() {
  return (
    <div className="robot-body-wrap">
      <div className="ghost-body">
        <div className="ghost-eye ghost-eye-left" />
        <div className="ghost-eye ghost-eye-right" />
        <div className="ghost-mouth" />
        <div className="ghost-blush ghost-blush-left" />
        <div className="ghost-blush ghost-blush-right" />
      </div>
      <div className="ghost-tail" />
    </div>
  );
}

function OrbBody() {
  return (
    <div className="robot-body-wrap">
      <div className="orb-core" />
      <div className="orb-ring orb-ring-1" />
      <div className="orb-ring orb-ring-2" />
      <div className="orb-particles">
        <span /><span /><span /><span />
      </div>
    </div>
  );
}

function DragonBody() {
  return (
    <div className="robot-body-wrap">
      <div className="dragon-head">
        <div className="dragon-horn dragon-horn-left" />
        <div className="dragon-horn dragon-horn-right" />
        <div className="dragon-eye dragon-eye-left" />
        <div className="dragon-eye dragon-eye-right" />
        <div className="dragon-nostril dragon-nostril-left" />
        <div className="dragon-nostril dragon-nostril-right" />
        <div className="dragon-mouth" />
      </div>
      <div className="dragon-neck" />
      <div className="dragon-body">
        <div className="dragon-belly" />
        <div className="dragon-wing dragon-wing-left" />
        <div className="dragon-wing dragon-wing-right" />
      </div>
      <div className="dragon-fire">
        <span /><span /><span />
      </div>
    </div>
  );
}

function PenguinBody() {
  return (
    <div className="robot-body-wrap">
      <div className="penguin-head">
        <div className="penguin-eye penguin-eye-left" />
        <div className="penguin-eye penguin-eye-right" />
        <div className="penguin-beak" />
      </div>
      <div className="penguin-body">
        <div className="penguin-belly" />
        <div className="penguin-flipper penguin-flipper-left" />
        <div className="penguin-flipper penguin-flipper-right" />
        <div className="penguin-feet" />
      </div>
    </div>
  );
}

function OctopusBody() {
  return (
    <div className="robot-body-wrap">
      <div className="octo-head">
        <div className="octo-eye octo-eye-left" />
        <div className="octo-eye octo-eye-right" />
        <div className="octo-mouth" />
      </div>
      <div className="octo-tentacles">
        <div className="octo-tent octo-tent-1" />
        <div className="octo-tent octo-tent-2" />
        <div className="octo-tent octo-tent-3" />
        <div className="octo-tent octo-tent-4" />
      </div>
    </div>
  );
}

function MushroomBody() {
  return (
    <div className="robot-body-wrap">
      <div className="mush-cap">
        <div className="mush-spot mush-spot-1" />
        <div className="mush-spot mush-spot-2" />
        <div className="mush-spot mush-spot-3" />
      </div>
      <div className="mush-face">
        <div className="mush-eye mush-eye-left" />
        <div className="mush-eye mush-eye-right" />
        <div className="mush-mouth" />
      </div>
      <div className="mush-stem" />
    </div>
  );
}

function FoxBody() {
  return (
    <div className="robot-body-wrap">
      <div className="fox-head">
        <div className="fox-ear fox-ear-left" />
        <div className="fox-ear fox-ear-right" />
        <div className="fox-eye fox-eye-left" />
        <div className="fox-eye fox-eye-right" />
        <div className="fox-snout" />
        <div className="fox-nose" />
      </div>
      <div className="fox-body">
        <div className="fox-chest" />
      </div>
      <div className="fox-tail" />
    </div>
  );
}

function UnicornBody() {
  return (
    <div className="robot-body-wrap">
      <div className="unicorn-head">
        <div className="unicorn-horn" />
        <div className="unicorn-eye unicorn-eye-left" />
        <div className="unicorn-eye unicorn-eye-right" />
        <div className="unicorn-mane" />
      </div>
      <div className="unicorn-body">
        <div className="unicorn-chest" />
      </div>
    </div>
  );
}

function JellyfishBody() {
  return (
    <div className="robot-body-wrap">
      <div className="jelly-bell">
        <div className="jelly-eye jelly-eye-left" />
        <div className="jelly-eye jelly-eye-right" />
        <div className="jelly-mouth" />
      </div>
      <div className="jelly-tentacles">
        <div className="jelly-tent jelly-tent-1" />
        <div className="jelly-tent jelly-tent-2" />
        <div className="jelly-tent jelly-tent-3" />
        <div className="jelly-tent jelly-tent-4" />
        <div className="jelly-tent jelly-tent-5" />
      </div>
    </div>
  );
}

function OwlBody() {
  return (
    <div className="robot-body-wrap">
      <div className="owl-head">
        <div className="owl-tuft owl-tuft-left" />
        <div className="owl-tuft owl-tuft-right" />
        <div className="owl-eye owl-eye-left"><div className="owl-pupil" /></div>
        <div className="owl-eye owl-eye-right"><div className="owl-pupil" /></div>
        <div className="owl-beak" />
      </div>
      <div className="owl-body">
        <div className="owl-wing owl-wing-left" />
        <div className="owl-wing owl-wing-right" />
        <div className="owl-chest" />
      </div>
    </div>
  );
}

function BatBody() {
  return (
    <div className="robot-body-wrap">
      <div className="bat-head">
        <div className="bat-ear bat-ear-left" />
        <div className="bat-ear bat-ear-right" />
        <div className="bat-eye bat-eye-left" />
        <div className="bat-eye bat-eye-right" />
        <div className="bat-fang bat-fang-left" />
        <div className="bat-fang bat-fang-right" />
      </div>
      <div className="bat-body">
        <div className="bat-wing bat-wing-left" />
        <div className="bat-wing bat-wing-right" />
      </div>
    </div>
  );
}

function CactusBody() {
  return (
    <div className="robot-body-wrap">
      <div className="cactus-flower" />
      <div className="cactus-body">
        <div className="cactus-eye cactus-eye-left" />
        <div className="cactus-eye cactus-eye-right" />
        <div className="cactus-mouth" />
        <div className="cactus-arm cactus-arm-left" />
        <div className="cactus-arm cactus-arm-right" />
      </div>
    </div>
  );
}

function SlimeBody() {
  return (
    <div className="robot-body-wrap">
      <div className="slime-body">
        <div className="slime-eye slime-eye-left" />
        <div className="slime-eye slime-eye-right" />
        <div className="slime-mouth" />
        <div className="slime-shine" />
      </div>
    </div>
  );
}

function PumpkinBody() {
  return (
    <div className="robot-body-wrap">
      <div className="pumpkin-stem" />
      <div className="pumpkin-body">
        <div className="pumpkin-eye pumpkin-eye-left" />
        <div className="pumpkin-eye pumpkin-eye-right" />
        <div className="pumpkin-mouth" />
        <div className="pumpkin-groove pumpkin-groove-left" />
        <div className="pumpkin-groove pumpkin-groove-right" />
      </div>
    </div>
  );
}

function YetiBody() {
  return (
    <div className="robot-body-wrap">
      <div className="yeti-head">
        <div className="yeti-horn yeti-horn-left" />
        <div className="yeti-horn yeti-horn-right" />
        <div className="yeti-eye yeti-eye-left" />
        <div className="yeti-eye yeti-eye-right" />
        <div className="yeti-mouth" />
      </div>
      <div className="yeti-body">
        <div className="yeti-belly" />
        <div className="yeti-fur" />
      </div>
    </div>
  );
}

function CrystalBody() {
  return (
    <div className="robot-body-wrap">
      <div className="crystal-body">
        <div className="crystal-facet crystal-facet-left" />
        <div className="crystal-facet crystal-facet-right" />
        <div className="crystal-eye crystal-eye-left" />
        <div className="crystal-eye crystal-eye-right" />
        <div className="crystal-core" />
      </div>
    </div>
  );
}

function BeeBody() {
  return (
    <div className="robot-body-wrap">
      <div className="bee-antenna bee-antenna-left" />
      <div className="bee-antenna bee-antenna-right" />
      <div className="bee-head">
        <div className="bee-eye bee-eye-left" />
        <div className="bee-eye bee-eye-right" />
      </div>
      <div className="bee-body">
        <div className="bee-stripe bee-stripe-1" />
        <div className="bee-stripe bee-stripe-2" />
        <div className="bee-wing bee-wing-left" />
        <div className="bee-wing bee-wing-right" />
        <div className="bee-stinger" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model body lookup
// ---------------------------------------------------------------------------

const MODEL_BODIES: Record<CharacterModelName, React.ComponentType> = {
  robot: RobotBody,
  cat: CatBody,
  alien: AlienBody,
  ghost: GhostBody,
  orb: OrbBody,
  dragon: DragonBody,
  penguin: PenguinBody,
  octopus: OctopusBody,
  mushroom: MushroomBody,
  fox: FoxBody,
  unicorn: UnicornBody,
  jellyfish: JellyfishBody,
  owl: OwlBody,
  bat: BatBody,
  cactus: CactusBody,
  slime: SlimeBody,
  pumpkin: PumpkinBody,
  yeti: YetiBody,
  crystal: CrystalBody,
  bee: BeeBody,
};

// ---------------------------------------------------------------------------
// CharacterModel component
// ---------------------------------------------------------------------------

export interface CharacterModelProps {
  model: CharacterModelName;
  status?: string;
  color?: string;
  emoting?: boolean;
  checked?: boolean;
}

export default function CharacterModel({
  model,
  status = 'idle',
  color,
  emoting = false,
  checked = false,
}: CharacterModelProps) {
  const BodyComponent = MODEL_BODIES[model] || MODEL_BODIES.robot;

  const className = [
    'css-robot',
    `char-${model}`,
    emoting ? 'robot-emote' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      data-status={status}
      data-checked={checked ? 'true' : undefined}
      style={color ? { '--robot-color': color } as React.CSSProperties : undefined}
    >
      <div className="robot-shadow" />
      <BodyComponent />
    </div>
  );
}
