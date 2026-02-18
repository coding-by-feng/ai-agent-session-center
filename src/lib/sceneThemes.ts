/**
 * Scene3D theme palettes — maps ThemeName to 3D scene colors.
 * Used by CyberdromeScene + CyberdromeEnvironment to react to theme changes.
 */
import type { ThemeName } from '@/stores/settingsStore';

export interface Scene3DTheme {
  // Canvas / fog
  background: string;
  fogDensity: number;

  // Floor
  floor: string;
  roomFloor: string;
  borderGlow: string;
  grid1: string;
  grid2: string;

  // Walls
  wall: string;
  wallOpacity: number;
  stripPrimary: string;
  stripSecondary: string;

  // Furniture
  desk: string;
  monitorFrame: string;
  chair: string;

  // Particles / traces
  particle1: string;
  particle2: string;
  trace3: string;
  stars: string;

  // Lighting
  ambientColor: string;
  ambientIntensity: number;
  dirColor: string;
  dirIntensity: number;
  fillColor: string;
  fillIntensity: number;
  pointLight1: string;
  pointLight2: string;
  pointLight3: string;
  hemisphereUp: string;
  hemisphereDown: string;
  hemisphereIntensity: number;

  // Room interior
  sconceColor: string;
  roomLight1: string;
  roomLight2: string;

  // Casual areas
  coffeeFloor: string;
  coffeeAccent: string;
  coffeeFurniture: string;
}

const COMMAND_CENTER: Scene3DTheme = {
  background: '#0e0c1a',
  fogDensity: 0.008,
  floor: '#1a1830',
  roomFloor: '#2e2850',
  borderGlow: '#00f0ff',
  grid1: '#00f0ff',
  grid2: '#ff00aa',
  wall: '#282845',
  wallOpacity: 0.55,
  stripPrimary: '#00f0ff',
  stripSecondary: '#ff00aa',
  desk: '#1c1c30',
  monitorFrame: '#111120',
  chair: '#222238',
  particle1: '#00f0ff',
  particle2: '#ff00aa',
  trace3: '#a855f7',
  stars: '#bbaaee',
  ambientColor: '#3a3060',
  ambientIntensity: 5,
  dirColor: '#d8caf0',
  dirIntensity: 3.5,
  fillColor: '#a0b8e0',
  fillIntensity: 1.5,
  pointLight1: '#00f0ff',
  pointLight2: '#ff00aa',
  pointLight3: '#8866ff',
  hemisphereUp: '#4a3a6e',
  hemisphereDown: '#1a1428',
  hemisphereIntensity: 2,
  sconceColor: '#f0e8d0',
  roomLight1: '#f0e8d0',
  roomLight2: '#d8d0e8',
  coffeeFloor: '#2a2018',
  coffeeAccent: '#d4882a',
  coffeeFurniture: '#5a3a20',
};

const CYBERPUNK: Scene3DTheme = {
  background: '#0d0221',
  fogDensity: 0.01,
  floor: '#150530',
  roomFloor: '#2a0a50',
  borderGlow: '#ff00ff',
  grid1: '#ff00ff',
  grid2: '#00ffff',
  wall: '#1e0840',
  wallOpacity: 0.6,
  stripPrimary: '#ff00ff',
  stripSecondary: '#00ffff',
  desk: '#1a0838',
  monitorFrame: '#0f0520',
  chair: '#200a40',
  particle1: '#ff00ff',
  particle2: '#00ffff',
  trace3: '#ff6b00',
  stars: '#dd88ff',
  ambientColor: '#2a1050',
  ambientIntensity: 4,
  dirColor: '#e0b0ff',
  dirIntensity: 3,
  fillColor: '#80c0ff',
  fillIntensity: 1.5,
  pointLight1: '#ff00ff',
  pointLight2: '#00ffff',
  pointLight3: '#ff6b00',
  hemisphereUp: '#3a1060',
  hemisphereDown: '#100520',
  hemisphereIntensity: 2,
  sconceColor: '#e0c0ff',
  roomLight1: '#e0c0ff',
  roomLight2: '#c0e0ff',
  coffeeFloor: '#200818',
  coffeeAccent: '#ff8820',
  coffeeFurniture: '#4a2010',
};

const WARM: Scene3DTheme = {
  background: '#f5ede0',
  fogDensity: 0.005,
  floor: '#e8ddd0',
  roomFloor: '#ddd0c0',
  borderGlow: '#d97706',
  grid1: '#d97706',
  grid2: '#b87333',
  wall: '#c8b8a0',
  wallOpacity: 0.7,
  stripPrimary: '#d97706',
  stripSecondary: '#b87333',
  desk: '#8b7355',
  monitorFrame: '#6b5540',
  chair: '#9a8468',
  particle1: '#d9a040',
  particle2: '#b87333',
  trace3: '#c2860c',
  stars: '#d4c4a8',
  ambientColor: '#f0e0c0',
  ambientIntensity: 8,
  dirColor: '#fff5e0',
  dirIntensity: 5,
  fillColor: '#ffe8c0',
  fillIntensity: 3,
  pointLight1: '#d97706',
  pointLight2: '#b87333',
  pointLight3: '#e8a020',
  hemisphereUp: '#fff8f0',
  hemisphereDown: '#d0c0a0',
  hemisphereIntensity: 4,
  sconceColor: '#ffe0a0',
  roomLight1: '#fff0d0',
  roomLight2: '#f0e0c0',
  coffeeFloor: '#c8b898',
  coffeeAccent: '#b87333',
  coffeeFurniture: '#8a6a40',
};

const DRACULA: Scene3DTheme = {
  background: '#282a36',
  fogDensity: 0.008,
  floor: '#1e1f2e',
  roomFloor: '#343648',
  borderGlow: '#bd93f9',
  grid1: '#bd93f9',
  grid2: '#50fa7b',
  wall: '#383a4e',
  wallOpacity: 0.6,
  stripPrimary: '#bd93f9',
  stripSecondary: '#50fa7b',
  desk: '#2a2c3e',
  monitorFrame: '#1a1c2e',
  chair: '#303248',
  particle1: '#bd93f9',
  particle2: '#50fa7b',
  trace3: '#ff79c6',
  stars: '#c8b8e8',
  ambientColor: '#44475a',
  ambientIntensity: 5,
  dirColor: '#f8f8f2',
  dirIntensity: 3,
  fillColor: '#c8c0e0',
  fillIntensity: 1.5,
  pointLight1: '#bd93f9',
  pointLight2: '#50fa7b',
  pointLight3: '#ff79c6',
  hemisphereUp: '#44475a',
  hemisphereDown: '#1a1c2e',
  hemisphereIntensity: 2,
  sconceColor: '#f8f8f2',
  roomLight1: '#f8f8f2',
  roomLight2: '#ddd8f0',
  coffeeFloor: '#2a2030',
  coffeeAccent: '#ffb86c',
  coffeeFurniture: '#4a3028',
};

const SOLARIZED: Scene3DTheme = {
  background: '#002b36',
  fogDensity: 0.008,
  floor: '#073642',
  roomFloor: '#0a4050',
  borderGlow: '#2aa198',
  grid1: '#2aa198',
  grid2: '#cb4b16',
  wall: '#0c4a58',
  wallOpacity: 0.6,
  stripPrimary: '#2aa198',
  stripSecondary: '#cb4b16',
  desk: '#073038',
  monitorFrame: '#042028',
  chair: '#0a3840',
  particle1: '#2aa198',
  particle2: '#cb4b16',
  trace3: '#b58900',
  stars: '#839496',
  ambientColor: '#1a4050',
  ambientIntensity: 5,
  dirColor: '#eee8d5',
  dirIntensity: 3,
  fillColor: '#93a1a1',
  fillIntensity: 1.5,
  pointLight1: '#2aa198',
  pointLight2: '#cb4b16',
  pointLight3: '#b58900',
  hemisphereUp: '#2a5a68',
  hemisphereDown: '#002028',
  hemisphereIntensity: 2,
  sconceColor: '#eee8d5',
  roomLight1: '#eee8d5',
  roomLight2: '#93a1a1',
  coffeeFloor: '#0a2828',
  coffeeAccent: '#cb4b16',
  coffeeFurniture: '#3a2818',
};

const NORD: Scene3DTheme = {
  background: '#2e3440',
  fogDensity: 0.008,
  floor: '#252b38',
  roomFloor: '#3b4252',
  borderGlow: '#88c0d0',
  grid1: '#88c0d0',
  grid2: '#d08770',
  wall: '#3b4252',
  wallOpacity: 0.6,
  stripPrimary: '#88c0d0',
  stripSecondary: '#d08770',
  desk: '#2e3440',
  monitorFrame: '#1e2430',
  chair: '#343c4c',
  particle1: '#88c0d0',
  particle2: '#d08770',
  trace3: '#b48ead',
  stars: '#81a1c1',
  ambientColor: '#3b4252',
  ambientIntensity: 5,
  dirColor: '#eceff4',
  dirIntensity: 3,
  fillColor: '#d8dee9',
  fillIntensity: 1.5,
  pointLight1: '#88c0d0',
  pointLight2: '#d08770',
  pointLight3: '#b48ead',
  hemisphereUp: '#4c566a',
  hemisphereDown: '#2e3440',
  hemisphereIntensity: 2,
  sconceColor: '#eceff4',
  roomLight1: '#eceff4',
  roomLight2: '#d8dee9',
  coffeeFloor: '#2a2228',
  coffeeAccent: '#d08770',
  coffeeFurniture: '#4a3030',
};

const MONOKAI: Scene3DTheme = {
  background: '#272822',
  fogDensity: 0.008,
  floor: '#1e1f1a',
  roomFloor: '#3e3d32',
  borderGlow: '#66d9ef',
  grid1: '#66d9ef',
  grid2: '#f92672',
  wall: '#3e3d32',
  wallOpacity: 0.6,
  stripPrimary: '#66d9ef',
  stripSecondary: '#f92672',
  desk: '#2a2a20',
  monitorFrame: '#1a1a14',
  chair: '#32322a',
  particle1: '#66d9ef',
  particle2: '#f92672',
  trace3: '#a6e22e',
  stars: '#a0a090',
  ambientColor: '#3e3d32',
  ambientIntensity: 5,
  dirColor: '#f8f8f2',
  dirIntensity: 3,
  fillColor: '#c8c8b8',
  fillIntensity: 1.5,
  pointLight1: '#66d9ef',
  pointLight2: '#f92672',
  pointLight3: '#a6e22e',
  hemisphereUp: '#4e4d40',
  hemisphereDown: '#1e1f1a',
  hemisphereIntensity: 2,
  sconceColor: '#f8f8f2',
  roomLight1: '#f8f8f2',
  roomLight2: '#d8d8c8',
  coffeeFloor: '#2a2018',
  coffeeAccent: '#f92672',
  coffeeFurniture: '#4a2a18',
};

const LIGHT: Scene3DTheme = {
  background: '#e8eaef',
  fogDensity: 0.004,
  floor: '#d8dae0',
  roomFloor: '#c8cad5',
  borderGlow: '#3b82f6',
  grid1: '#3b82f6',
  grid2: '#0ea5e9',
  wall: '#b8bac8',
  wallOpacity: 0.7,
  stripPrimary: '#3b82f6',
  stripSecondary: '#0ea5e9',
  desk: '#888898',
  monitorFrame: '#686878',
  chair: '#989aa8',
  particle1: '#3b82f6',
  particle2: '#0ea5e9',
  trace3: '#7c3aed',
  stars: '#b0b8d0',
  ambientColor: '#e0e4f0',
  ambientIntensity: 10,
  dirColor: '#ffffff',
  dirIntensity: 5,
  fillColor: '#e0e8ff',
  fillIntensity: 3,
  pointLight1: '#3b82f6',
  pointLight2: '#0ea5e9',
  pointLight3: '#7c3aed',
  hemisphereUp: '#f0f4ff',
  hemisphereDown: '#c0c4d0',
  hemisphereIntensity: 5,
  sconceColor: '#fff8f0',
  roomLight1: '#ffffff',
  roomLight2: '#e0e4f0',
  coffeeFloor: '#c0b0a0',
  coffeeAccent: '#b87333',
  coffeeFurniture: '#8a7050',
};

const BLONDE: Scene3DTheme = {
  background: '#f0e8d8',
  fogDensity: 0.005,
  floor: '#e0d8c8',
  roomFloor: '#d5cab8',
  borderGlow: '#ca8a04',
  grid1: '#ca8a04',
  grid2: '#a16207',
  wall: '#c0b49a',
  wallOpacity: 0.7,
  stripPrimary: '#ca8a04',
  stripSecondary: '#a16207',
  desk: '#8a7a60',
  monitorFrame: '#6a5a44',
  chair: '#9a8a70',
  particle1: '#ca9a20',
  particle2: '#a16207',
  trace3: '#b89040',
  stars: '#d0c4a8',
  ambientColor: '#f0e0c0',
  ambientIntensity: 8,
  dirColor: '#fff8e8',
  dirIntensity: 5,
  fillColor: '#ffe8c8',
  fillIntensity: 3,
  pointLight1: '#ca8a04',
  pointLight2: '#a16207',
  pointLight3: '#d4a020',
  hemisphereUp: '#fff8e8',
  hemisphereDown: '#c8b898',
  hemisphereIntensity: 4,
  sconceColor: '#ffe8b0',
  roomLight1: '#fff0d8',
  roomLight2: '#f0e0c8',
  coffeeFloor: '#c8b898',
  coffeeAccent: '#a16207',
  coffeeFurniture: '#8a6a38',
};

const SCENE_THEMES: Record<ThemeName, Scene3DTheme> = {
  'command-center': COMMAND_CENTER,
  cyberpunk: CYBERPUNK,
  warm: WARM,
  dracula: DRACULA,
  solarized: SOLARIZED,
  nord: NORD,
  monokai: MONOKAI,
  light: LIGHT,
  blonde: BLONDE,
};

export function getScene3DTheme(themeName: ThemeName): Scene3DTheme {
  return SCENE_THEMES[themeName] ?? COMMAND_CENTER;
}
