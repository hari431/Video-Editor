/**
 * Standalone 3D Avatar Face Replacement — Procedural 3D Character Avatar Head Generator
 *
 * Constructs 15 genuinely DISTINCT 3D toon character faces with different head shapes,
 * face proportions, eye shape/size, hair/head silhouettes, ears, facial hair, accessories,
 * and visual personalities in Three.js with full ARKit-compatible morph target deformation vertices
 * (jawOpen, eyeBlinkLeft, eyeBlinkRight, mouthSmileLeft, mouthSmileRight, mouthFunnel, etc.).
 */

function generatePreviewSVG(characterId) {
  const svgs = {
    'toon-boy': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="16" fill="#1e293b"/>
      <circle cx="50" cy="54" r="32" fill="#ffcdb2"/>
      <!-- Hair -->
      <path d="M 20 48 C 18 26, 40 18, 50 18 C 65 18, 82 28, 80 48 C 72 32, 58 26, 50 26 C 42 26, 28 32, 20 48 Z" fill="#3d2314"/>
      <path d="M 45 18 L 52 8 L 58 18 Z" fill="#3d2314"/>
      <path d="M 32 22 L 38 12 L 44 20 Z" fill="#3d2314"/>
      <!-- Eyes -->
      <circle cx="38" cy="50" r="7" fill="#ffffff"/>
      <circle cx="62" cy="50" r="7" fill="#ffffff"/>
      <circle cx="38" cy="50" r="3.5" fill="#0284c7"/>
      <circle cx="62" cy="50" r="3.5" fill="#0284c7"/>
      <!-- Nose & Mouth -->
      <circle cx="50" cy="58" r="3" fill="#e09f87"/>
      <path d="M 42 66 Q 50 72 58 66" stroke="#9a3412" stroke-width="2.5" stroke-linecap="round" fill="none"/>
      <!-- Shirt Collar -->
      <path d="M 32 82 L 50 92 L 68 82" stroke="#0284c7" stroke-width="8" stroke-linecap="round" fill="none"/>
    </svg>`,

    'toon-girl': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="16" fill="#1e293b"/>
      <!-- Pigtails -->
      <circle cx="18" cy="42" r="14" fill="#9a3412"/>
      <circle cx="82" cy="42" r="14" fill="#9a3412"/>
      <!-- Head -->
      <path d="M 22 52 C 22 30, 78 30, 78 52 C 78 74, 50 78, 50 78 C 50 78, 22 74, 22 52 Z" fill="#ffdfd3"/>
      <!-- Headband & Hair bangs -->
      <path d="M 24 40 Q 50 30 76 40" stroke="#eab308" stroke-width="4" stroke-linecap="round" fill="none"/>
      <path d="M 26 42 Q 50 24 74 42 Q 50 34 26 42 Z" fill="#9a3412"/>
      <!-- Rosy Cheeks -->
      <circle cx="32" cy="58" r="5" fill="#f472b6" opacity="0.6"/>
      <circle cx="68" cy="58" r="5" fill="#f472b6" opacity="0.6"/>
      <!-- Eyes & Lashes -->
      <circle cx="38" cy="50" r="6" fill="#ffffff"/>
      <circle cx="62" cy="50" r="6" fill="#ffffff"/>
      <circle cx="38" cy="50" r="3" fill="#0d9488"/>
      <circle cx="62" cy="50" r="3" fill="#0d9488"/>
      <path d="M 32 44 Q 38 42 44 45" stroke="#1e293b" stroke-width="2" fill="none"/>
      <path d="M 56 45 Q 62 42 68 44" stroke="#1e293b" stroke-width="2" fill="none"/>
      <!-- Mouth -->
      <path d="M 44 65 Q 50 70 56 65" stroke="#be123c" stroke-width="2.5" stroke-linecap="round" fill="none"/>
    </svg>`,

    'adult-man': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="16" fill="#1e293b"/>
      <!-- Rectangular Jaw Head -->
      <rect x="25" y="28" width="50" height="54" rx="12" fill="#e2a780"/>
      <!-- Dark Stubble -->
      <path d="M 25 58 L 25 72 Q 50 86 75 72 L 75 58 Z" fill="#38281d" opacity="0.25"/>
      <!-- Hair -->
      <path d="M 23 35 C 23 18, 77 18, 77 35 L 77 28 Q 50 16 23 28 Z" fill="#1e1008"/>
      <!-- Brow Ridge & Eyebrows -->
      <path d="M 32 42 L 44 42" stroke="#1e1008" stroke-width="3" stroke-linecap="round"/>
      <path d="M 56 42 L 68 42" stroke="#1e1008" stroke-width="3" stroke-linecap="round"/>
      <!-- Eyes -->
      <ellipse cx="38" cy="48" rx="5" ry="4" fill="#ffffff"/>
      <ellipse cx="62" cy="48" rx="5" ry="4" fill="#ffffff"/>
      <circle cx="38" cy="48" r="2.5" fill="#1e293b"/>
      <circle cx="62" cy="48" r="2.5" fill="#1e293b"/>
      <!-- Nose & Firm Mouth -->
      <path d="M 50 48 L 47 58 L 53 58" stroke="#c0825e" stroke-width="2" fill="none"/>
      <line x1="40" y1="68" x2="60" y2="68" stroke="#884d2b" stroke-width="2.5" stroke-linecap="round"/>
    </svg>`,

    'adult-woman': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="16" fill="#1e293b"/>
      <!-- Flowing Hair Back -->
      <path d="M 16 35 C 16 15, 84 15, 84 35 L 86 85 L 14 85 Z" fill="#271c19"/>
      <!-- Slender Oval Head -->
      <ellipse cx="50" cy="52" rx="24" ry="30" fill="#ffe4d6"/>
      <!-- Eyes & Glam Eyeliner -->
      <ellipse cx="38" cy="48" rx="6" ry="5" fill="#ffffff"/>
      <ellipse cx="62" cy="48" rx="6" ry="5" fill="#ffffff"/>
      <circle cx="38" cy="48" r="3" fill="#7e22ce"/>
      <circle cx="62" cy="48" r="3" fill="#7e22ce"/>
      <path d="M 30 44 Q 38 40 46 45" stroke="#000000" stroke-width="2.5" fill="none"/>
      <path d="M 54 45 Q 62 40 70 44" stroke="#000000" stroke-width="2.5" fill="none"/>
      <!-- Full Red Lips -->
      <path d="M 42 66 Q 50 62 58 66 Q 50 74 42 66 Z" fill="#e11d48"/>
      <!-- Gold Earrings -->
      <circle cx="24" cy="58" r="4" stroke="#eab308" stroke-width="2" fill="none"/>
      <circle cx="76" cy="58" r="4" stroke="#eab308" stroke-width="2" fill="none"/>
    </svg>`,

    'elderly-man': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="16" fill="#1e293b"/>
      <!-- Elongated Head -->
      <ellipse cx="50" cy="54" rx="24" ry="32" fill="#d49b78"/>
      <!-- Receding Grey Hair Sides -->
      <path d="M 22 45 Q 18 30 28 24 Q 24 45 22 55 Z" fill="#94a3b8"/>
      <path d="M 78 45 Q 82 30 72 24 Q 76 45 78 55 Z" fill="#94a3b8"/>
      <!-- Forehead Wrinkles -->
      <path d="M 36 32 Q 50 28 64 32" stroke="#a36d4a" stroke-width="1.5" stroke-linecap="round" fill="none"/>
      <path d="M 38 37 Q 50 33 62 37" stroke="#a36d4a" stroke-width="1.5" stroke-linecap="round" fill="none"/>
      <!-- Bushy White Eyebrows -->
      <path d="M 32 44 Q 40 40 46 44" stroke="#f8fafc" stroke-width="4" stroke-linecap="round"/>
      <path d="M 54 44 Q 60 40 68 44" stroke="#f8fafc" stroke-width="4" stroke-linecap="round"/>
      <!-- Eyes & Prominent Nose -->
      <circle cx="38" cy="49" r="3" fill="#1e293b"/>
      <circle cx="62" cy="49" r="3" fill="#1e293b"/>
      <ellipse cx="50" cy="56" rx="6" ry="7" fill="#c0825e"/>
      <!-- Bushy White Mustache -->
      <path d="M 34 68 Q 50 60 66 68 Q 50 76 34 68 Z" fill="#f8fafc"/>
    </svg>`,

    'elderly-woman': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="16" fill="#1e293b"/>
      <!-- Hair Bun Top -->
      <circle cx="50" cy="18" r="14" fill="#e2e8f0"/>
      <!-- Plump Round Head -->
      <circle cx="50" cy="54" r="30" fill="#f5c2a5"/>
      <!-- Silver Waves -->
      <path d="M 20 48 C 20 28, 80 28, 80 48 Z" fill="#e2e8f0"/>
      <!-- Spectacles -->
      <circle cx="38" cy="52" r="9" stroke="#eab308" stroke-width="2" fill="none"/>
      <circle cx="62" cy="52" r="9" stroke="#eab308" stroke-width="2" fill="none"/>
      <line x1="47" y1="52" x2="53" y2="52" stroke="#eab308" stroke-width="2"/>
      <!-- Eyes inside glasses -->
      <circle cx="38" cy="52" r="2.5" fill="#1e293b"/>
      <circle cx="62" cy="52" r="2.5" fill="#1e293b"/>
      <!-- Gentle Smile -->
      <path d="M 42 68 Q 50 74 58 68" stroke="#be123c" stroke-width="2.5" stroke-linecap="round" fill="none"/>
    </svg>`,

    'geek-dev': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="16" fill="#1e293b"/>
      <!-- Narrow Face -->
      <ellipse cx="50" cy="54" rx="22" ry="30" fill="#ffe8dc"/>
      <!-- Messy Dev Hair -->
      <path d="M 24 45 C 20 20, 80 18, 76 45 Q 60 22 50 28 Q 38 20 24 45 Z" fill="#291d18"/>
      <!-- Thick Black Glasses -->
      <rect x="26" y="44" width="20" height="14" rx="3" stroke="#0f172a" stroke-width="3" fill="none"/>
      <rect x="54" y="44" width="20" height="14" rx="3" stroke="#0f172a" stroke-width="3" fill="none"/>
      <line x1="46" y1="48" x2="54" y2="48" stroke="#0f172a" stroke-width="3"/>
      <!-- Wide Eyes -->
      <circle cx="36" cy="51" r="3" fill="#0f172a"/>
      <circle cx="64" cy="51" r="3" fill="#0f172a"/>
      <!-- Smile -->
      <path d="M 42 68 Q 50 74 58 68" stroke="#9a3412" stroke-width="2.5" stroke-linecap="round" fill="none"/>
      <!-- Hoodie -->
      <path d="M 28 84 L 50 92 L 72 84" stroke="#2563eb" stroke-width="8" stroke-linecap="round" fill="none"/>
    </svg>`,

    'wizard': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="16" fill="#1e293b"/>
      <!-- Wizard Lavender Face -->
      <ellipse cx="50" cy="52" rx="22" ry="28" fill="#c084fc"/>
      <!-- Flowing White Beard -->
      <path d="M 28 58 Q 50 100 72 58 Q 50 70 28 58 Z" fill="#f8fafc"/>
      <!-- Wizard Hat -->
      <path d="M 18 36 L 82 36 L 50 5 Z" fill="#312e81"/>
      <ellipse cx="50" cy="36" rx="36" ry="6" fill="#1e1b4b"/>
      <!-- Gold Star on Hat -->
      <polygon points="50,15 52,20 57,20 53,23 55,28 50,25 45,28 47,23 43,20 48,20" fill="#facc15"/>
      <!-- Glowing Eyes -->
      <circle cx="38" cy="46" r="4" fill="#facc15"/>
      <circle cx="62" cy="46" r="4" fill="#facc15"/>
      <circle cx="38" cy="46" r="1.5" fill="#1e1b4b"/>
      <circle cx="62" cy="46" r="1.5" fill="#1e1b4b"/>
    </svg>`,

    'cyber-bot': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="16" fill="#0f172a"/>
      <!-- Blocky Chrome Head -->
      <rect x="22" y="24" width="56" height="56" rx="10" fill="#94a3b8" stroke="#475569" stroke-width="3"/>
      <!-- Side Bolts / Antennae -->
      <rect x="12" y="44" width="10" height="16" rx="2" fill="#64748b"/>
      <rect x="78" y="44" width="10" height="16" rx="2" fill="#64748b"/>
      <circle cx="17" cy="40" r="3" fill="#f97316"/>
      <circle cx="83" cy="40" r="3" fill="#f97316"/>
      <!-- Glowing Cyan Visor -->
      <rect x="28" y="38" width="44" height="16" rx="4" fill="#06b6d4"/>
      <circle cx="40" cy="46" r="4" fill="#ffffff"/>
      <circle cx="60" cy="46" r="4" fill="#ffffff"/>
      <!-- Speaker Grille Mouth -->
      <rect x="34" y="62" width="32" height="10" rx="2" fill="#334155"/>
      <line x1="40" y1="67" x2="60" y2="67" stroke="#06b6d4" stroke-width="2" stroke-dasharray="2 2"/>
    </svg>`,

    'friendly-alien': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="16" fill="#0f172a"/>
      <!-- Antennae -->
      <path d="M 38 28 L 26 12" stroke="#84cc16" stroke-width="3" stroke-linecap="round"/>
      <path d="M 62 28 L 74 12" stroke="#84cc16" stroke-width="3" stroke-linecap="round"/>
      <circle cx="24" cy="10" r="5" fill="#c084fc"/>
      <circle cx="76" cy="10" r="5" fill="#c084fc"/>
      <!-- Bulbous Alien Cranium -->
      <path d="M 18 42 C 18 18, 82 18, 82 42 C 82 62, 62 78, 50 78 C 38 78, 18 62, 18 42 Z" fill="#84cc16"/>
      <!-- Huge Slanted Dark Eyes -->
      <ellipse cx="36" cy="48" rx="11" ry="15" fill="#090514" transform="rotate(-15 36 48)"/>
      <ellipse cx="64" cy="48" rx="11" ry="15" fill="#090514" transform="rotate(15 64 48)"/>
      <ellipse cx="34" cy="44" rx="4" ry="6" fill="#ffffff" transform="rotate(-15 34 44)"/>
      <ellipse cx="62" cy="44" rx="4" ry="6" fill="#ffffff" transform="rotate(15 62 44)"/>
      <!-- Tiny Mouth -->
      <ellipse cx="50" cy="68" rx="4" ry="2" fill="#3f6212"/>
    </svg>`,

    'magical-cat': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="16" fill="#1e293b"/>
      <!-- Pointy Ears -->
      <polygon points="20,45 32,15 44,38" fill="#d8b4fe"/>
      <polygon points="25,42 32,20 39,38" fill="#f472b6"/>
      <polygon points="80,45 68,15 56,38" fill="#d8b4fe"/>
      <polygon points="75,42 68,20 61,38" fill="#f472b6"/>
      <!-- Broad Cat Head -->
      <ellipse cx="50" cy="55" rx="32" ry="25" fill="#fae8ff"/>
      <!-- White Muzzle -->
      <ellipse cx="50" cy="64" rx="16" ry="10" fill="#ffffff"/>
      <!-- Eyes & Slit Pupils -->
      <ellipse cx="36" cy="48" rx="7" ry="8" fill="#facc15"/>
      <ellipse cx="64" cy="48" rx="7" ry="8" fill="#facc15"/>
      <line x1="36" y1="41" x2="36" y2="55" stroke="#1c1917" stroke-width="2.5"/>
      <line x1="64" y1="41" x2="64" y2="55" stroke="#1c1917" stroke-width="2.5"/>
      <!-- Pink Nose & Whiskers -->
      <polygon points="50,60 46,55 54,55" fill="#f472b6"/>
      <line x1="20" y1="60" x2="38" y2="62" stroke="#475569" stroke-width="1.5"/>
      <line x1="18" y1="67" x2="38" y2="65" stroke="#475569" stroke-width="1.5"/>
      <line x1="80" y1="60" x2="62" y2="62" stroke="#475569" stroke-width="1.5"/>
      <line x1="82" y1="67" x2="62" y2="65" stroke="#475569" stroke-width="1.5"/>
    </svg>`,

    'cute-bear': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="16" fill="#1e293b"/>
      <!-- Round Teddy Ears -->
      <circle cx="24" cy="28" r="13" fill="#854d0e"/>
      <circle cx="24" cy="28" r="7" fill="#fde047" opacity="0.6"/>
      <circle cx="76" cy="28" r="13" fill="#854d0e"/>
      <circle cx="76" cy="28" r="7" fill="#fde047" opacity="0.6"/>
      <!-- Heavy Bear Head -->
      <circle cx="50" cy="54" r="32" fill="#854d0e"/>
      <!-- Light Tan Snout -->
      <ellipse cx="50" cy="62" rx="18" ry="13" fill="#fde047" opacity="0.85"/>
      <!-- Dark Bear Nose & Mouth -->
      <ellipse cx="50" cy="56" rx="7" ry="5" fill="#1c1917"/>
      <path d="M 50 61 L 50 67 M 44 67 Q 50 71 56 67" stroke="#1c1917" stroke-width="2" stroke-linecap="round" fill="none"/>
      <!-- Eyes -->
      <circle cx="36" cy="46" r="4.5" fill="#1c1917"/>
      <circle cx="64" cy="46" r="4.5" fill="#1c1917"/>
      <circle cx="37" cy="45" r="1.5" fill="#ffffff"/>
      <circle cx="65" cy="45" r="1.5" fill="#ffffff"/>
    </svg>`,

    'stylized-skull': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="16" fill="#0f172a"/>
      <!-- Skull Cranium -->
      <path d="M 22 46 C 22 20, 78 20, 78 46 C 78 58, 70 64, 68 76 L 32 76 C 30 64, 22 58, 22 46 Z" fill="#f1f5f9"/>
      <!-- Sunken Eye Sockets -->
      <circle cx="38" cy="46" r="9" fill="#0f172a"/>
      <circle cx="62" cy="46" r="9" fill="#0f172a"/>
      <!-- Nose Cavity -->
      <polygon points="50,56 46,63 54,63" fill="#0f172a"/>
      <!-- Teeth Jaw -->
      <line x1="36" y1="70" x2="64" y2="70" stroke="#0f172a" stroke-width="2"/>
      <line x1="42" y1="66" x2="42" y2="74" stroke="#0f172a" stroke-width="2"/>
      <line x1="50" y1="66" x2="50" y2="74" stroke="#0f172a" stroke-width="2"/>
      <line x1="58" y1="66" x2="58" y2="74" stroke="#0f172a" stroke-width="2"/>
    </svg>`,

    'superhero': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="16" fill="#1e293b"/>
      <!-- Chiseled Head -->
      <path d="M 26 42 C 26 24, 74 24, 74 42 C 74 68, 62 82, 50 82 C 38 82, 26 68, 26 42 Z" fill="#ffdfd3"/>
      <!-- Domino Mask -->
      <path d="M 22 40 Q 50 48 78 40 L 76 54 Q 50 62 24 54 Z" fill="#1d4ed8"/>
      <!-- Heroic Eyes inside mask -->
      <ellipse cx="38" cy="47" rx="6" ry="3" fill="#ffffff"/>
      <ellipse cx="62" cy="47" rx="6" ry="3" fill="#ffffff"/>
      <!-- Golden Swoop Hair -->
      <path d="M 24 38 C 24 16, 76 16, 76 38 Q 50 18 24 38 Z" fill="#eab308"/>
      <path d="M 50 18 Q 70 8 82 22 Q 62 24 50 18 Z" fill="#facc15"/>
      <!-- Jaw Dimple & Smile -->
      <path d="M 42 68 Q 50 72 58 68" stroke="#b91c1c" stroke-width="2.5" stroke-linecap="round" fill="none"/>
    </svg>`,

    'jester-clown': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="16" fill="#1e293b"/>
      <!-- White Face Paint Head -->
      <ellipse cx="50" cy="54" rx="28" ry="30" fill="#f8fafc"/>
      <!-- 3-Point Jester Hat -->
      <path d="M 22 36 L 6 12 Q 22 22 32 32 Z" fill="#d92626"/>
      <path d="M 50 32 L 50 4 L 56 32 Z" fill="#eab308"/>
      <path d="M 78 36 L 94 12 Q 78 22 68 32 Z" fill="#d92626"/>
      <!-- Jingle Bells -->
      <circle cx="6" cy="12" r="4" fill="#facc15"/>
      <circle cx="50" cy="4" r="4" fill="#facc15"/>
      <circle cx="94" cy="12" r="4" fill="#facc15"/>
      <!-- Star Eye Makeup -->
      <polygon points="38,42 40,46 44,46 41,49 42,53 38,50 34,53 35,49 32,46 36,46" fill="#0284c7"/>
      <polygon points="62,42 64,46 68,46 65,49 66,53 62,50 58,53 59,49 56,46 60,46" fill="#0284c7"/>
      <circle cx="38" cy="48" r="2.5" fill="#1e293b"/>
      <circle cx="62" cy="48" r="2.5" fill="#1e293b"/>
      <!-- Big Red Nose -->
      <circle cx="50" cy="56" r="8" fill="#d92626"/>
      <circle cx="48" cy="54" r="2.5" fill="#ffffff" opacity="0.7"/>
      <!-- Exaggerated Red Smile -->
      <path d="M 34 66 Q 50 82 66 66 Q 50 72 34 66 Z" fill="#be123c"/>
    </svg>`
  };

  const raw = svgs[characterId] || svgs['toon-boy'];
  return `data:image/svg+xml;utf8,${encodeURIComponent(raw)}`;
}

export const AVATAR_CHARACTER_LIST = [
  { id: 'toon-boy', name: 'Young Boy', emoji: '👦', category: 'Human', description: 'Chubby round child face with messy hair tufts and wide blue eyes', previewUrl: generatePreviewSVG('toon-boy') },
  { id: 'toon-girl', name: 'Young Girl', emoji: '👧', category: 'Human', description: 'Soft heart-shaped face with auburn pigtails, headband, and rosy cheeks', previewUrl: generatePreviewSVG('toon-girl') },
  { id: 'adult-man', name: 'Adult Man', emoji: '👨', category: 'Human', description: 'Defined rectangular jaw face with dark side-part hair and stubble', previewUrl: generatePreviewSVG('adult-man') },
  { id: 'adult-woman', name: 'Adult Woman', emoji: '👩', category: 'Human', description: 'High-cheekbone oval face with wavy brunette hair frame and red lips', previewUrl: generatePreviewSVG('adult-woman') },
  { id: 'elderly-man', name: 'Elderly Man', emoji: '👴', category: 'Human', description: 'Elongated weathered face with bushy white mustache and receding hair', previewUrl: generatePreviewSVG('elderly-man') },
  { id: 'elderly-woman', name: 'Elderly Woman', emoji: '👵', category: 'Human', description: 'Plump rounded face with gold wire spectacles and silver hair bun', previewUrl: generatePreviewSVG('elderly-woman') },
  { id: 'geek-dev', name: 'Geek Developer', emoji: '🤓', category: 'Human', description: 'Narrow face with thick black glasses and swooped hair tuft', previewUrl: generatePreviewSVG('geek-dev') },
  { id: 'wizard', name: 'Wizard Mystic', emoji: '🧙', category: 'Fantasy', description: 'Tall mystical face with pointed star hat and long white beard', previewUrl: generatePreviewSVG('wizard') },
  { id: 'cyber-bot', name: 'Cyber Bot', emoji: '🤖', category: 'Sci-Fi', description: 'Blocky chamfered chrome robot head with glowing cyan LED visor screen', previewUrl: generatePreviewSVG('cyber-bot') },
  { id: 'friendly-alien', name: 'Distinctive Alien', emoji: '👽', category: 'Sci-Fi', description: 'Bulbous pear-shaped cranium with huge slanted dark eyes and antennae', previewUrl: generatePreviewSVG('friendly-alien') },
  { id: 'magical-cat', name: 'Toon Cat', emoji: '🐱', category: 'Animal', description: 'Broad feline head with protruding snout, pointed ears and whiskers', previewUrl: generatePreviewSVG('magical-cat') },
  { id: 'cute-bear', name: 'Teddy Bear', emoji: '🐻', category: 'Animal', description: 'Round heavy bear head with large tan snout, round ears and dark nose', previewUrl: generatePreviewSVG('cute-bear') },
  { id: 'stylized-skull', name: 'Stylized Skull', emoji: '💀', category: 'Fantasy', description: 'Anatomical toon bone skull with sunken eye sockets and toothy jaw', previewUrl: generatePreviewSVG('stylized-skull') },
  { id: 'superhero', name: 'Superhero', emoji: '🦸', category: 'Fantasy', description: 'Heroic chiseled face with royal blue domino mask and golden hair', previewUrl: generatePreviewSVG('superhero') },
  { id: 'jester-clown', name: 'Expressive Clown', emoji: '🎭', category: 'Seasonal', description: 'Theatrical jester with 3-point jingle hat, red nose and star eye paint', previewUrl: generatePreviewSVG('jester-clown') }
];

/**
 * Attaches ARKit-compatible morph target deformation attributes to any head geometry
 */
function attachMorphTargetsToHeadGeometry(THREE, headGeo) {
  const positionAttr = headGeo.attributes.position;
  const vertexCount = positionAttr.count;

  const morphTargetNames = [
    'jawOpen',
    'eyeBlinkLeft',
    'eyeBlinkRight',
    'mouthSmileLeft',
    'mouthSmileRight',
    'mouthFunnel',
    'mouthPucker',
    'browOuterUpLeft',
    'browOuterUpRight',
    'browInnerUp',
    'eyeLookInLeft',
    'eyeLookOutLeft',
    'eyeLookInRight',
    'eyeLookOutRight'
  ];

  const morphTargetDictionary = {};
  const morphAttributesPosition = [];

  for (let m = 0; m < morphTargetNames.length; m++) {
    const shapeName = morphTargetNames[m];
    morphTargetDictionary[shapeName] = m;

    const morphPositions = new Float32Array(vertexCount * 3);

    for (let i = 0; i < vertexCount; i++) {
      const x = positionAttr.getX(i);
      const y = positionAttr.getY(i);
      const z = positionAttr.getZ(i);

      let dx = 0, dy = 0, dz = 0;

      // Jaw Open Morph Target
      if (shapeName === 'jawOpen' && y < -0.05) {
        dy = -0.28 * Math.abs(y + 0.1);
        dz = 0.08 * Math.abs(y);
      }

      // Eye Blink Morphs
      if (shapeName === 'eyeBlinkLeft' && x < -0.05 && y > 0.05 && z > 0.1) {
        dy = -0.08;
      }
      if (shapeName === 'eyeBlinkRight' && x > 0.05 && y > 0.05 && z > 0.1) {
        dy = -0.08;
      }

      // Mouth Smile Morphs
      if (shapeName === 'mouthSmileLeft' && x < -0.05 && y < 0 && z > 0.1) {
        dy = 0.09;
        dx = -0.05;
      }
      if (shapeName === 'mouthSmileRight' && x > 0.05 && y < 0 && z > 0.1) {
        dy = 0.09;
        dx = 0.05;
      }

      // Mouth Funnel & Pucker
      if (shapeName === 'mouthFunnel' && Math.hypot(x, y + 0.2) < 0.25 && z > 0.15) {
        dz = 0.15;
      }
      if (shapeName === 'mouthPucker' && Math.hypot(x, y + 0.2) < 0.25 && z > 0.15) {
        dz = 0.20;
        dx = x * -0.3;
      }

      // Eyebrow Morphs
      if (shapeName === 'browOuterUpLeft' && x < -0.1 && y > 0.15) {
        dy = 0.08;
      }
      if (shapeName === 'browOuterUpRight' && x > 0.1 && y > 0.15) {
        dy = 0.08;
      }
      if (shapeName === 'browInnerUp' && Math.abs(x) < 0.12 && y > 0.15) {
        dy = 0.08;
      }

      morphPositions[i * 3] = x + dx;
      morphPositions[i * 3 + 1] = y + dy;
      morphPositions[i * 3 + 2] = z + dz;
    }

    const morphAttr = new THREE.BufferAttribute(morphPositions, 3);
    morphAttr.name = shapeName;
    morphAttributesPosition.push(morphAttr);
  }

  headGeo.morphAttributes.position = morphAttributesPosition;
  return morphTargetDictionary;
}

/**
 * Per-character head-sculpt parameters. Subtle displacement of the base
 * sphere/box (same vertex count and order) applied BEFORE morph targets,
 * so the ARKit contract and animation math are untouched.
 * Fields: jaw taper, chin extension, cheek fullness, brow ridge,
 * temple pinch, back-skull fullness. box:true softens sculpt for Box heads.
 */
export const HEAD_SCULPT = {
  'toon-boy':      { jaw: 0.04, chin: 0.004, cheek: 0.060, brow: 0.006, temple: 0.010, skull: 0.020 },
  'toon-girl':     { jaw: 0.14, chin: 0.014, cheek: 0.030, brow: 0.006, temple: 0.040, skull: 0.020 },
  'adult-man':     { jaw: 0.02, chin: 0.008, cheek: 0.020, brow: 0.014, temple: 0.020, skull: 0.010, box: true },
  'adult-woman':   { jaw: 0.12, chin: 0.012, cheek: 0.025, brow: 0.008, temple: 0.050, skull: 0.020 },
  'elderly-man':   { jaw: 0.08, chin: 0.016, cheek: 0.015, brow: 0.012, temple: 0.040, skull: 0.015 },
  'elderly-woman': { jaw: 0.03, chin: 0.004, cheek: 0.070, brow: 0.006, temple: 0.010, skull: 0.020 },
  'geek-dev':      { jaw: 0.12, chin: 0.012, cheek: 0.020, brow: 0.008, temple: 0.050, skull: 0.020 },
  'wizard':        { jaw: 0.10, chin: 0.014, cheek: 0.020, brow: 0.014, temple: 0.040, skull: 0.015 },
  'cyber-bot':     { jaw: 0.01, chin: 0.002, cheek: 0.000, brow: 0.000, temple: 0.000, skull: 0.000, box: true },
  'friendly-alien':{ jaw: 0.02, chin: 0.002, cheek: 0.080, brow: 0.004, temple: 0.000, skull: 0.050 },
  'magical-cat':   { jaw: 0.06, chin: 0.006, cheek: 0.070, brow: 0.006, temple: 0.020, skull: 0.030 },
  'cute-bear':     { jaw: 0.03, chin: 0.003, cheek: 0.080, brow: 0.005, temple: 0.010, skull: 0.040 },
  'stylized-skull':{ jaw: 0.10, chin: 0.010, cheek: -0.020, brow: 0.012, temple: 0.050, skull: 0.010 },
  'superhero':     { jaw: 0.05, chin: 0.012, cheek: 0.020, brow: 0.012, temple: 0.040, skull: 0.015 },
  'jester-clown':  { jaw: 0.06, chin: 0.008, cheek: 0.050, brow: 0.008, temple: 0.020, skull: 0.020 },
  'default':       { jaw: 0.08, chin: 0.010, cheek: 0.030, brow: 0.008, temple: 0.030, skull: 0.015 }
};

/**
 * Displace head vertices to carve jaw, chin, cheeks, brow, temples, skull.
 * Operates on the position array in place; skips safely when no array
 * (mock geometries). Returns true when sculpt was applied.
 */
export function sculptHeadGeometry(headGeo, characterId) {
  const p = HEAD_SCULPT[characterId] || HEAD_SCULPT.default;
  const soft = p.box ? 0.4 : 1.0;
  const pos = headGeo.attributes && headGeo.attributes.position;
  if (!pos || !pos.array || !pos.count || !pos.array.length) return false;
  const arr = pos.array;
  for (let i = 0; i < pos.count; i++) {
    let x = arr[i * 3];
    let y = arr[i * 3 + 1];
    let z = arr[i * 3 + 2];
    // Jaw taper: narrow the lower sides.
    if (y < 0.02) {
      const t = Math.min(1, (0.02 - y) / 0.55);
      x *= 1 - p.jaw * soft * t * Math.min(1, Math.abs(x) / 0.3 + 0.3);
    }
    // Chin: extend and narrow the bottom-center front.
    if (y < -0.32 && Math.abs(x) < 0.18 && z > 0) {
      y -= p.chin * soft * (1 - Math.abs(x) / 0.18);
      x *= 0.97;
    }
    // Cheeks: widen (or hollow for negative, e.g. skull) the mid sides.
    if (y > -0.12 && y < 0.16 && Math.abs(x) > 0.28) {
      x += Math.sign(x) * p.cheek * soft * Math.max(0, 1 - Math.abs(y) / 0.3);
    }
    // Brow ridge: bring the upper front slightly forward.
    if (y > 0.18 && y < 0.36 && z > 0.28) {
      z += p.brow * soft * Math.max(0, 1 - Math.abs(y - 0.27) / 0.12);
    }
    // Temples: pinch the upper sides for heart/oval reads.
    if (y > 0.12 && y < 0.32 && Math.abs(x) > 0.32) {
      x *= 1 - p.temple * soft * 0.5;
    }
    // Back-skull fullness for round/alien/bear reads.
    if (z < -0.1) {
      z -= p.skull * soft * 0.5 * Math.min(1, -z / 0.4);
    }
    arr[i * 3] = x;
    arr[i * 3 + 1] = y;
    arr[i * 3 + 2] = z;
  }
  if (typeof headGeo.computeVertexNormals === 'function') {
    try { headGeo.computeVertexNormals(); } catch (_) {}
  }
  return true;
}

/**
 * Ear slot per character (head half-width + seating margin). Humans only;
 * fantasy/animal characters keep their bespoke ears or none.
 */
export const EAR_X = {
  'toon-boy': 0.58, 'toon-girl': 0.51, 'adult-man': 0.44, 'adult-woman': 0.47,
  'elderly-man': 0.47, 'elderly-woman': 0.59, 'geek-dev': 0.45, 'wizard': 0.46,
  'superhero': 0.51, 'jester-clown': 0.56
};

export const BROW_THICKNESS = {
  'elderly-man': 0.045, 'wizard': 0.030, 'geek-dev': 0.028, 'jester-clown': 0.028
};

const NOSELESS_CHARACTERS = ['cyber-bot', 'friendly-alien', 'magical-cat', 'cute-bear', 'stylized-skull'];

export function createAvatarPartBuilders(THREE) {
  // Shared stepped toon gradient so hair/accessory shading is deliberate,
  // not at the mercy of light angles. Guarded for mock THREE runtimes.
  let sharedGradient = null;
  try {
    if (typeof THREE.DataTexture === 'function' && THREE.NearestFilter !== undefined) {
      const data = new Uint8Array([110, 150, 200, 255]);
      const fmt = THREE.RedFormat !== undefined ? THREE.RedFormat : THREE.RGBAFormat;
      const tex = new THREE.DataTexture(data, 4, 1, fmt);
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.needsUpdate = true;
      sharedGradient = tex;
    }
  } catch (_) {
    sharedGradient = null;
  }
  const toon = (color, extra = {}) => {
    const mat = new THREE.MeshToonMaterial({ color, ...extra });
    if (sharedGradient && mat) {
      try { mat.gradientMap = sharedGradient; } catch (_) {}
    }
    return mat;
  };
  const basic = (color, extra = {}) => new THREE.MeshBasicMaterial({ color, ...extra });

  // Coherent recessed mouth assembly shared by every character.
  function buildMouthAssembly(lipColor) {
    const mouthGroup = new THREE.Group();
    const cavityGeo = new THREE.SphereGeometry(0.12, 16, 16);
    cavityGeo.scale(1.2, 0.4, 0.5);
    const mouthCavity = new THREE.Mesh(cavityGeo, basic(0x240810));
    mouthCavity.position.set(0, -0.18, 0.41);
    mouthGroup.add(mouthCavity);

    const teethMat = basic(0xffffff);
    const teethUpper = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.035, 0.03), teethMat);
    teethUpper.position.set(0, -0.155, 0.435);
    mouthGroup.add(teethUpper);
    // Gum line behind the upper teeth for a finished (non-floating) read.
    const gumMesh = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.014, 0.015), basic(0x7f1d2e));
    gumMesh.position.set(0, -0.134, 0.428);
    mouthGroup.add(gumMesh);
    const teethLower = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.03, 0.03), teethMat);
    teethLower.position.set(0, -0.205, 0.435);
    mouthGroup.add(teethLower);

    const lipMat = toon(lipColor);

    const upperLip = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.030, 12, 24, Math.PI), lipMat);
    upperLip.rotation.x = Math.PI;
    upperLip.position.set(0, -0.15, 0.45);
    mouthGroup.add(upperLip);
    const lowerLip = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.032, 12, 24, Math.PI), lipMat);
    lowerLip.position.set(0, -0.21, 0.45);
    mouthGroup.add(lowerLip);

    const baseMouth = {
      upperLipY: upperLip.position.y,
      lowerLipY: lowerLip.position.y,
      upperLipZ: upperLip.position.z,
      lowerLipZ: lowerLip.position.z,
      teethUpperY: teethUpper.position.y,
      teethLowerY: teethLower.position.y,
      upperLipScaleX: upperLip.scale.x,
      lowerLipScaleX: lowerLip.scale.x,
      cavityScaleY: mouthCavity.scale.y
    };
    return { mouthGroup, mouthCavity, upperLip, lowerLip, teethUpper, teethLower, baseMouth };
  }

  // Symmetric forward-facing eye pair with pupils + lid folds.
  // lashColor adds a lash line; null keeps a natural lid.
  function buildEyePair(eyeColor, pupilColor, skinColor, eyeX = 0.18, eyeY = 0.12, eyeZ = 0.42, lashColor = null) {
    const eyeGeo = new THREE.SphereGeometry(0.09, 16, 16);
    const eyeMat = new THREE.MeshPhongMaterial({ color: eyeColor, shininess: 100 });
    const pupilGeo = new THREE.SphereGeometry(0.045, 16, 16);
    const pupilMat = basic(pupilColor);
    const lidMat = toon(skinColor);
    const lidGeo = new THREE.TorusGeometry(0.095, 0.016, 8, 20, Math.PI);
    const makeSide = (sx) => {
      const eyeGroup = new THREE.Group();
      eyeGroup.position.set(sx * eyeX, eyeY, eyeZ);
      const eyeMesh = new THREE.Mesh(eyeGeo, eyeMat);
      const pupilMesh = new THREE.Mesh(pupilGeo, pupilMat);
      pupilMesh.position.set(0, 0, 0.06);
      eyeGroup.add(eyeMesh);
      eyeGroup.add(pupilMesh);
      // Upper lid fold hugging the sclera (skin material, attached look).
      const lid = new THREE.Mesh(lidGeo, lidMat);
      lid.position.set(0, 0.028, 0.052);
      eyeGroup.add(lid);
      if (lashColor !== null && lashColor !== undefined) {
        const lashGeo = new THREE.BoxGeometry(0.15, 0.014, 0.014);
        const lash = new THREE.Mesh(lashGeo, basic(lashColor));
        lash.position.set(0, 0.062, 0.045);
        lash.rotation.z = sx * -0.06;
        eyeGroup.add(lash);
      }
      return { eyeGroup, pupilMesh };
    };
    const left = makeSide(-1);
    const right = makeSide(1);
    return {
      leftEyeGroup: left.eyeGroup,
      rightEyeGroup: right.eyeGroup,
      leftPupilMesh: left.pupilMesh,
      rightPupilMesh: right.pupilMesh
    };
  }

  // Brows seated into the brow band (sunk, angled, tapered thickness).
  function buildBrows(browColor, eyeX = 0.18, eyeY = 0.12, eyeZ = 0.42, thick = 0.022) {
    const browGeo = new THREE.BoxGeometry(0.15, thick, 0.035);
    const browMat = basic(browColor);
    const leftBrowMesh = new THREE.Mesh(browGeo, browMat);
    leftBrowMesh.position.set(-eyeX, eyeY + 0.135, eyeZ + 0.015);
    leftBrowMesh.rotation.z = 0.08;
    const rightBrowMesh = new THREE.Mesh(browGeo, browMat);
    rightBrowMesh.position.set(eyeX, eyeY + 0.135, eyeZ + 0.015);
    rightBrowMesh.rotation.z = -0.08;
    return { leftBrowMesh, rightBrowMesh };
  }

  // Nose with bridge + tip as one attached group (no ball-on-face).
  function buildNose(noseColor, size = 0.06) {
    const noseGroup = new THREE.Group();
    const bridgeGeo = new THREE.SphereGeometry(size, 14, 12);
    bridgeGeo.scale(0.5, 1.15, 0.7);
    const bridge = new THREE.Mesh(bridgeGeo, toon(noseColor));
    bridge.position.set(0, 0.035, 0.435 + size * 0.35);
    bridge.rotation.x = 0.18;
    noseGroup.add(bridge);
    const tipGeo = new THREE.SphereGeometry(size, 16, 14);
    tipGeo.scale(0.85, 0.9, 0.9);
    const tip = new THREE.Mesh(tipGeo, toon(noseColor));
    tip.position.set(0, -0.02, 0.46 + size * 0.9);
    noseGroup.add(tip);
    return noseGroup;
  }

  // Human ears seated on the head sides (skin material, attached look).
  function buildEars(skinMat, earX) {
    const earGroup = new THREE.Group();
    const earGeo = new THREE.SphereGeometry(0.11, 14, 12);
    earGeo.scale(0.35, 1.0, 0.6);
    const leftEar = new THREE.Mesh(earGeo, skinMat);
    leftEar.position.set(-earX, 0.0, -0.03);
    const rightEarGeo = new THREE.SphereGeometry(0.11, 14, 12);
    rightEarGeo.scale(0.35, 1.0, 0.6);
    const rightEar = new THREE.Mesh(rightEarGeo, skinMat);
    rightEar.position.set(earX, 0.0, -0.03);
    earGroup.add(leftEar);
    earGroup.add(rightEar);
    return earGroup;
  }

  // Connected neck + trapezius shoulders + collar ring (one composition).
  function buildNeckSet(headMat, shirtColor) {
    const setGroup = new THREE.Group();
    const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.20, 0.24, 16), headMat);
    neckMesh.position.set(0, -0.58, 0);
    setGroup.add(neckMesh);
    // Trapezius slope: shirt-color mass intersecting head bottom + neck.
    const slopeGeo = new THREE.SphereGeometry(0.30, 20, 16);
    slopeGeo.scale(1.5, 0.65, 0.85);
    const shirtMesh = new THREE.Mesh(slopeGeo, toon(shirtColor));
    shirtMesh.position.set(0, -0.74, -0.03);
    setGroup.add(shirtMesh);
    // Collar ring seated at the neck base (no floating cone rim).
    const ringMesh = new THREE.Mesh(new THREE.TorusGeometry(0.20, 0.035, 12, 24), toon(shirtColor));
    ringMesh.rotation.x = Math.PI / 2 - 0.12;
    ringMesh.position.set(0, -0.63, 0.01);
    setGroup.add(ringMesh);
    return { setGroup, neckMesh, shirtMesh, ringMesh };
  }

  // Hair cap seated over the head (radius exceeds head so it cannot sink).
  function buildSeatedCap(hairMat, sx = 1.05, sy = 1.0) {
    const capGeo = new THREE.SphereGeometry(0.55, 24, 24);
    capGeo.scale(sx, sy, 1.0);
    const cap = new THREE.Mesh(capGeo, hairMat);
    cap.position.set(0, 0.14, -0.06);
    return cap;
  }

  // Layered strand cluster: stacked flattened spheres read as hair locks
  // with volume (never cones). Each strand: [x, y, z, r, sx, sy, sz, rotZ].
  function buildStrandCluster(material, strands) {
    const grp = new THREE.Group();
    for (const s of strands) {
      const [x, y, z, r, sx = 1, sy = 1.3, sz = 0.9, rz = 0] = s;
      const g = new THREE.SphereGeometry(r, 14, 12);
      g.scale(sx, sy, sz);
      const strand = new THREE.Mesh(g, material);
      strand.position.set(x, y, z);
      if (rz) strand.rotation.z = rz;
      grp.add(strand);
    }
    return grp;
  }

  // Fringe row across the hairline: varied lengths, attached (not floating).
  function buildFringe(material, y, z, halfWidth, count, r) {
    const strands = [];
    for (let k = 0; k < count; k++) {
      const t = count === 1 ? 0 : (k / (count - 1)) * 2 - 1;
      const len = 1.15 - Math.abs(t) * 0.45 + ((k * 37) % 10) / 60;
      strands.push([t * halfWidth, y - Math.abs(t) * 0.03, z, r, 0.9, len, 0.75, t * -0.18]);
    }
    return buildStrandCluster(material, strands);
  }

  // Sideburn・・connects hair mass into the jaw (kills the shell read).
  function buildSideburn(material, side, x, topY, length) {
    return buildStrandCluster(material, [
      [side * x, topY, 0.20, 0.055, 0.8, 1.0, 0.7, 0],
      [side * (x + 0.005), topY - length * 0.55, 0.21, 0.048, 0.8, 1.1, 0.7, 0],
      [side * (x + 0.01), topY - length, 0.22, 0.040, 0.8, 1.0, 0.7, 0]
    ]);
  }

  return { toon, basic, buildMouthAssembly, buildEyePair, buildBrows, buildNose, buildEars, buildNeckSet, buildSeatedCap, buildStrandCluster, buildFringe, buildSideburn };
}

export function createProcedural3DToonAvatar(THREE, characterId = 'toon-boy') {
  const group = new THREE.Group();
  group.name = `AvatarToonCharacterGroup_${characterId}`;

  const charMeta = AVATAR_CHARACTER_LIST.find(c => c.id === characterId) || AVATAR_CHARACTER_LIST[0];

  // Colors & Materials per character
  let skinColor = 0xffcdb2;
  let hairColor = 0x3d2314;
  let eyeColor = 0xffffff;
  let pupilColor = 0x1a202c;
  let noseColor = 0xe09f87;
  let shirtColor = 0x0284c7;
  let eyebrowColor = 0x2b1810;

  let headGeo;
  let isMetallic = false;

  switch (characterId) {
    case 'toon-boy':
      // Chubby round child face
      headGeo = new THREE.SphereGeometry(0.5, 32, 32);
      headGeo.scale(1.1, 1.05, 1.02);
      skinColor = 0xffcdb2;
      hairColor = 0x3d2314;
      shirtColor = 0x0284c7;
      break;

    case 'toon-girl':
      // Soft heart-shaped child face
      headGeo = new THREE.SphereGeometry(0.48, 32, 32);
      headGeo.scale(0.95, 1.12, 0.95);
      skinColor = 0xffdfd3;
      hairColor = 0x9a3412; // Auburn
      pupilColor = 0x0d9488; // Teal
      shirtColor = 0x0d9488;
      break;

    case 'adult-man':
      // Rectangular jawed head
      headGeo = new THREE.BoxGeometry(0.82, 1.12, 0.88, 16, 16, 16);
      skinColor = 0xe2a780;
      hairColor = 0x1e1008;
      eyebrowColor = 0x1e1008;
      shirtColor = 0x334155;
      break;

    case 'adult-woman':
      // Slender oval head with high cheekbones
      headGeo = new THREE.SphereGeometry(0.46, 32, 32);
      headGeo.scale(0.88, 1.25, 0.88);
      skinColor = 0xffe4d6;
      hairColor = 0x271c19;
      pupilColor = 0x7e22ce;
      shirtColor = 0xbe123c;
      break;

    case 'elderly-man':
      // Elongated weathered face
      headGeo = new THREE.SphereGeometry(0.48, 32, 32);
      headGeo.scale(0.88, 1.35, 1.0);
      skinColor = 0xd49b78;
      hairColor = 0x94a3b8;
      eyebrowColor = 0xf8fafc;
      shirtColor = 0x78350f;
      break;

    case 'elderly-woman':
      // Plump rounded grandmother head
      headGeo = new THREE.SphereGeometry(0.52, 32, 32);
      headGeo.scale(1.12, 1.1, 1.05);
      skinColor = 0xf5c2a5;
      hairColor = 0xe2e8f0;
      shirtColor = 0xa855f7;
      break;

    case 'geek-dev':
      // Narrow face
      headGeo = new THREE.SphereGeometry(0.46, 32, 32);
      headGeo.scale(0.84, 1.3, 0.9);
      skinColor = 0xffe8dc;
      hairColor = 0x291d18;
      shirtColor = 0x2563eb;
      break;

    case 'wizard':
      // Tall mystical lavender face
      headGeo = new THREE.SphereGeometry(0.48, 32, 32);
      headGeo.scale(0.85, 1.38, 0.95);
      skinColor = 0xc084fc;
      hairColor = 0xf8fafc;
      eyeColor = 0xfacc15;
      pupilColor = 0x1e1b4b;
      shirtColor = 0x312e81;
      break;

    case 'cyber-bot':
      // Blocky chamfered chrome robot head
      headGeo = new THREE.BoxGeometry(0.85, 0.92, 0.85, 16, 16, 16);
      skinColor = 0x94a3b8;
      isMetallic = true;
      shirtColor = 0x1e293b;
      break;

    case 'friendly-alien':
      // Bulbous inverted pear cranium
      headGeo = new THREE.SphereGeometry(0.56, 32, 32);
      headGeo.scale(1.3, 1.28, 1.0);
      skinColor = 0x84cc16; // Lime green
      eyeColor = 0x090514;
      pupilColor = 0xffffff;
      shirtColor = 0xea580c;
      break;

    case 'magical-cat':
      // Broad feline head
      headGeo = new THREE.SphereGeometry(0.5, 32, 32);
      headGeo.scale(1.25, 1.0, 1.0);
      skinColor = 0xfae8ff; // Lavender/cream
      hairColor = 0xd8b4fe;
      eyeColor = 0xfacc15;
      pupilColor = 0x1c1917;
      noseColor = 0xf472b6;
      shirtColor = 0x9333ea;
      break;

    case 'cute-bear':
      // Heavy round bear head
      headGeo = new THREE.SphereGeometry(0.54, 32, 32);
      headGeo.scale(1.15, 1.12, 1.08);
      skinColor = 0x854d0e;
      hairColor = 0x713f12;
      noseColor = 0x1c1917;
      shirtColor = 0xea580c;
      break;

    case 'stylized-skull':
      // Anatomical bone skull
      headGeo = new THREE.SphereGeometry(0.48, 32, 32);
      headGeo.scale(0.95, 1.1, 0.95);
      skinColor = 0xf1f5f9;
      eyeColor = 0x0f172a;
      pupilColor = 0x0f172a;
      shirtColor = 0x334155;
      break;

    case 'superhero':
      // Heroic chiseled head
      headGeo = new THREE.SphereGeometry(0.5, 32, 32);
      headGeo.scale(0.95, 1.25, 1.0);
      skinColor = 0xffdfd3;
      hairColor = 0xeab308; // Golden
      shirtColor = 0xd97706;
      break;

    case 'jester-clown':
      // Theatrical face shape
      headGeo = new THREE.SphereGeometry(0.5, 32, 32);
      headGeo.scale(1.05, 1.15, 1.0);
      skinColor = 0xf8fafc; // White face paint
      hairColor = 0xd92626;
      noseColor = 0xd92626;
      shirtColor = 0xd92626;
      break;

    default:
      headGeo = new THREE.SphereGeometry(0.5, 32, 32);
      headGeo.scale(1.0, 1.25, 1.0);
      break;
  }

  // Sculpt anatomical structure into the head BEFORE morph targets
  // (displacement only: vertex count/order preserved, contract intact).
  sculptHeadGeometry(headGeo, characterId);

  // Attach ARKit Morph Target Attributes
  const morphTargetDictionary = attachMorphTargetsToHeadGeometry(THREE, headGeo);

  // Material creation: soft modeled skin (metallic branch untouched).
  let headMat;
  if (isMetallic) {
    headMat = new THREE.MeshStandardMaterial({
      color: skinColor,
      metalness: 0.85,
      roughness: 0.2
    });
  } else {
    headMat = new THREE.MeshStandardMaterial({
      color: skinColor,
      metalness: 0.0,
      roughness: 0.55
    });
  }

  const headMesh = new THREE.Mesh(headGeo, headMat);
  headMesh.name = 'AvatarHeadMesh';
  headMesh.morphTargetDictionary = morphTargetDictionary;
  headMesh.morphTargetInfluences = new Float32Array(Object.keys(morphTargetDictionary).length);

  group.add(headMesh);

  // Shared coherent part builders (one geometry language for all 15).
  const parts = createAvatarPartBuilders(THREE);

  // Character-Specific Accessories, Hair, Ears, and Features
  // (hair uses the shared stepped gradient for deliberate toon shading).
  const hairMat = parts.toon(hairColor);

  if (characterId === 'toon-boy') {
    // Textured crop: seated cap + layered strand spikes + attached fringe.
    const hairGroup = new THREE.Group();
    const hairCap = parts.buildSeatedCap(hairMat, 1.14, 1.04);
    hairGroup.add(hairCap);
    hairGroup.add(parts.buildStrandCluster(hairMat, [
      [-0.24, 0.56, 0.10, 0.115, 0.85, 1.25, 0.8, -0.28],
      [0.0, 0.60, 0.14, 0.125, 0.9, 1.3, 0.8, 0.0],
      [0.24, 0.56, 0.10, 0.115, 0.85, 1.25, 0.8, 0.28],
      [-0.12, 0.58, -0.06, 0.11, 0.9, 1.2, 0.85, -0.12],
      [0.12, 0.58, -0.06, 0.11, 0.9, 1.2, 0.85, 0.12]
    ]));
    hairGroup.add(parts.buildFringe(hairMat, 0.44, 0.36, 0.30, 5, 0.085));
    group.add(hairGroup);

  } else if (characterId === 'toon-girl') {
    // Golden Headband & Pigtails
    const bandGeo = new THREE.TorusGeometry(0.48, 0.03, 12, 32);
    const bandMat = new THREE.MeshToonMaterial({ color: 0xeab308 });
    const bandMesh = new THREE.Mesh(bandGeo, bandMat);
    bandMesh.rotation.x = Math.PI * 0.45;
    bandMesh.position.set(0, 0.28, 0.05);
    group.add(bandMesh);

    // Side strand pigtails with volume + hairline fringe.
    group.add(parts.buildStrandCluster(hairMat, [
      [-0.52, 0.30, -0.08, 0.15, 0.9, 1.2, 0.9, 0.35],
      [-0.55, 0.08, -0.10, 0.12, 0.9, 1.3, 0.9, 0.3],
      [-0.56, -0.12, -0.10, 0.09, 0.9, 1.3, 0.9, 0.25]
    ]));
    group.add(parts.buildStrandCluster(hairMat, [
      [0.52, 0.30, -0.08, 0.15, 0.9, 1.2, 0.9, -0.35],
      [0.55, 0.08, -0.10, 0.12, 0.9, 1.3, 0.9, -0.3],
      [0.56, -0.12, -0.10, 0.09, 0.9, 1.3, 0.9, -0.25]
    ]));
    group.add(parts.buildFringe(hairMat, 0.42, 0.36, 0.26, 5, 0.08));

    // Rosy Cheeks
    const cheekGeo = new THREE.SphereGeometry(0.08, 16, 16);
    cheekGeo.scale(1, 0.8, 0.2);
    const cheekMat = new THREE.MeshToonMaterial({ color: 0xf472b6, transparent: true, opacity: 0.75 });
    const leftCheek = new THREE.Mesh(cheekGeo, cheekMat);
    leftCheek.position.set(-0.25, -0.02, 0.44);
    const rightCheek = new THREE.Mesh(cheekGeo, cheekMat);
    rightCheek.position.set(0.25, -0.02, 0.44);
    group.add(leftCheek);
    group.add(rightCheek);

  } else if (characterId === 'adult-man') {
    // Neat Side-Part Hair Cap, swoop fringe & jaw-connected sideburns
    const hairCapGeo = new THREE.BoxGeometry(0.86, 0.45, 0.9);
    const hairCap = new THREE.Mesh(hairCapGeo, hairMat);
    hairCap.position.set(0, 0.42, -0.02);
    group.add(hairCap);
    group.add(parts.buildFringe(hairMat, 0.46, 0.38, 0.28, 5, 0.08));
    group.add(parts.buildSideburn(hairMat, -1, 0.14, 0.30));
    group.add(parts.buildSideburn(hairMat, 1, 0.14, 0.30));

  } else if (characterId === 'adult-woman') {
    // Flowing Wavy Brunette Hairstyle Frame with layered locks + fringe
    const hairFrameGeo = new THREE.TorusGeometry(0.52, 0.12, 16, 32);
    const hairFrame = new THREE.Mesh(hairFrameGeo, hairMat);
    hairFrame.position.set(0, 0.1, -0.05);
    group.add(hairFrame);
    group.add(parts.buildStrandCluster(hairMat, [
      [-0.44, 0.05, 0.10, 0.13, 0.85, 1.6, 0.9, 0.15],
      [-0.46, -0.22, 0.08, 0.11, 0.85, 1.6, 0.9, 0.12],
      [0.44, 0.05, 0.10, 0.13, 0.85, 1.6, 0.9, -0.15],
      [0.46, -0.22, 0.08, 0.11, 0.85, 1.6, 0.9, -0.12]
    ]));
    group.add(parts.buildFringe(hairMat, 0.44, 0.34, 0.27, 6, 0.075));

    // Gold Hoop Earrings
    const hoopGeo = new THREE.TorusGeometry(0.08, 0.015, 12, 24);
    const hoopMat = new THREE.MeshToonMaterial({ color: 0xeab308 });
    const leftHoop = new THREE.Mesh(hoopGeo, hoopMat);
    leftHoop.position.set(-0.48, -0.12, 0);
    const rightHoop = new THREE.Mesh(hoopGeo, hoopMat);
    rightHoop.position.set(0.48, -0.12, 0);
    group.add(leftHoop);
    group.add(rightHoop);

    // (Lips come from the shared mouth assembly with red lip color — no
    // separate blob, so nothing can float or duplicate.)

  } else if (characterId === 'elderly-man') {
    // Bushy White Mustache & Receding Grey Side Hair
    const stacheGeo = new THREE.CylinderGeometry(0.06, 0.18, 0.38, 16);
    const stacheMat = new THREE.MeshToonMaterial({ color: 0xf8fafc });
    const stacheMesh = new THREE.Mesh(stacheGeo, stacheMat);
    stacheMesh.rotation.z = Math.PI / 2;
    stacheMesh.position.set(0, -0.16, 0.46);
    group.add(stacheMesh);

    const hairSideGeo = new THREE.SphereGeometry(0.22, 16, 16);
    const hairSideMat = new THREE.MeshToonMaterial({ color: 0x94a3b8 });
    const leftSide = new THREE.Mesh(hairSideGeo, hairSideMat);
    leftSide.position.set(-0.42, 0.15, -0.1);
    leftSide.scale.set(0.7, 1.3, 0.9);
    const rightSide = new THREE.Mesh(hairSideGeo, hairSideMat);
    rightSide.position.set(0.42, 0.15, -0.1);
    rightSide.scale.set(0.7, 1.3, 0.9);
    group.add(leftSide);
    group.add(rightSide);
    // Wispy fringe + short back volume so the scalp is never bare.
    group.add(parts.buildFringe(hairSideMat, 0.48, 0.30, 0.24, 4, 0.07));

  } else if (characterId === 'elderly-woman') {
    // High Silver Hair Bun & Gold Wire Spectacles
    const bunGeo = new THREE.SphereGeometry(0.22, 20, 20);
    const bunMat = new THREE.MeshToonMaterial({ color: 0xe2e8f0 });
    const bunMesh = new THREE.Mesh(bunGeo, bunMat);
    bunMesh.position.set(0, 0.62, -0.1);
    group.add(bunMesh);
    // Silver cap seating the bun (head half-width 0.58 needs cover).
    const silverCap = parts.buildSeatedCap(hairMat, 1.10, 1.0);
    group.add(silverCap);

    const glassGeo = new THREE.TorusGeometry(0.12, 0.02, 12, 24);
    const glassMat = new THREE.MeshToonMaterial({ color: 0xeab308 });
    const leftGlass = new THREE.Mesh(glassGeo, glassMat);
    leftGlass.position.set(-0.2, 0.12, 0.48);
    const rightGlass = new THREE.Mesh(glassGeo, glassMat);
    rightGlass.position.set(0.2, 0.12, 0.48);
    group.add(leftGlass);
    group.add(rightGlass);

  } else if (characterId === 'geek-dev') {
    // Thick Black Developer Glasses
    const frameGeo = new THREE.BoxGeometry(0.24, 0.18, 0.04);
    const frameMat = new THREE.MeshToonMaterial({ color: 0x0f172a });
    const leftFrame = new THREE.Mesh(frameGeo, frameMat);
    leftFrame.position.set(-0.18, 0.12, 0.46);
    const rightFrame = new THREE.Mesh(frameGeo, frameMat);
    rightFrame.position.set(0.18, 0.12, 0.46);
    group.add(leftFrame);
    group.add(rightFrame);

    // Layered developer tuft (flattened strands, not a faceted blob)
    group.add(parts.buildStrandCluster(hairMat, [
      [-0.12, 0.56, 0.10, 0.12, 0.9, 1.25, 0.8, -0.2],
      [0.02, 0.60, 0.12, 0.13, 0.9, 1.3, 0.8, 0.05],
      [0.15, 0.55, 0.08, 0.11, 0.9, 1.2, 0.8, 0.22]
    ]));
    group.add(parts.buildFringe(hairMat, 0.47, 0.33, 0.24, 4, 0.075));

  } else if (characterId === 'wizard') {
    // Tall Pointed Star Wizard Hat & Flowing Beard
    const hatBaseGeo = new THREE.TorusGeometry(0.58, 0.08, 16, 32);
    const hatMat = new THREE.MeshToonMaterial({ color: 0x312e81 });
    const hatBase = new THREE.Mesh(hatBaseGeo, hatMat);
    hatBase.rotation.x = Math.PI * 0.45;
    hatBase.position.set(0, 0.52, 0.02);
    group.add(hatBase);

    const hatConeGeo = new THREE.ConeGeometry(0.38, 0.8, 24);
    const hatCone = new THREE.Mesh(hatConeGeo, hatMat);
    hatCone.position.set(0, 0.92, -0.05);
    hatCone.rotation.x = -0.15;
    group.add(hatCone);

    // Long Flowing White Beard: layered locks down the front
    const beardMat = hairMat;
    group.add(parts.buildStrandCluster(beardMat, [
      [-0.10, -0.30, 0.38, 0.13, 0.9, 1.5, 0.85, 0.08],
      [0.10, -0.30, 0.38, 0.13, 0.9, 1.5, 0.85, -0.08],
      [0.0, -0.48, 0.36, 0.15, 0.9, 1.5, 0.85, 0.0],
      [0.0, -0.66, 0.32, 0.11, 0.85, 1.4, 0.8, 0.0]
    ]));

  } else if (characterId === 'cyber-bot') {
    // Glowing Cyan LED Visor Screen & Antenna Bolts
    const visorGeo = new THREE.BoxGeometry(0.68, 0.18, 0.1);
    const visorMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4 });
    const visorMesh = new THREE.Mesh(visorGeo, visorMat);
    visorMesh.position.set(0, 0.12, 0.42);
    group.add(visorMesh);

    const boltGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.25, 12);
    const boltMat = new THREE.MeshStandardMaterial({ color: 0x64748b, metalness: 0.8, roughness: 0.2 });
    const leftBolt = new THREE.Mesh(boltGeo, boltMat);
    leftBolt.position.set(-0.48, 0.1, 0);
    leftBolt.rotation.z = Math.PI / 2;
    const rightBolt = new THREE.Mesh(boltGeo, boltMat);
    rightBolt.position.set(0.48, 0.1, 0);
    rightBolt.rotation.z = Math.PI / 2;
    group.add(leftBolt);
    group.add(rightBolt);

  } else if (characterId === 'friendly-alien') {
    // Dual Antennae with Glowing Purple Orbs
    const antGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.38, 12);
    const orbGeo = new THREE.SphereGeometry(0.08, 16, 16);
    const antMat = new THREE.MeshToonMaterial({ color: 0x65a30d });
    const orbMat = new THREE.MeshToonMaterial({ color: 0xc084fc });

    const leftAnt = new THREE.Mesh(antGeo, antMat);
    leftAnt.position.set(-0.25, 0.72, 0);
    leftAnt.rotation.z = -0.28;
    const leftOrb = new THREE.Mesh(orbGeo, orbMat);
    leftOrb.position.set(-0.32, 0.92, 0);

    const rightAnt = new THREE.Mesh(antGeo, antMat);
    rightAnt.position.set(0.25, 0.72, 0);
    rightAnt.rotation.z = 0.28;
    const rightOrb = new THREE.Mesh(orbGeo, orbMat);
    rightOrb.position.set(0.32, 0.92, 0);

    group.add(leftAnt);
    group.add(leftOrb);
    group.add(rightAnt);
    group.add(rightOrb);

  } else if (characterId === 'magical-cat') {
    // Cat Snout, Pointed Ears, and Whiskers
    const snoutGeo = new THREE.SphereGeometry(0.2, 16, 16);
    snoutGeo.scale(1.2, 0.75, 0.8);
    const snoutMat = new THREE.MeshToonMaterial({ color: 0xffffff });
    const snoutMesh = new THREE.Mesh(snoutGeo, snoutMat);
    snoutMesh.position.set(0, -0.12, 0.42);
    group.add(snoutMesh);

    const earGeo = new THREE.ConeGeometry(0.16, 0.32, 16);
    const earMat = headMat;
    const leftEar = new THREE.Mesh(earGeo, earMat);
    leftEar.position.set(-0.35, 0.52, 0.05);
    leftEar.rotation.z = -0.25;
    const rightEar = new THREE.Mesh(earGeo, earMat);
    rightEar.position.set(0.35, 0.52, 0.05);
    rightEar.rotation.z = 0.25;
    group.add(leftEar);
    group.add(rightEar);

    // Inner-ear pink (attached, slightly proud of the outer ear front).
    const innerEarGeo = new THREE.ConeGeometry(0.07, 0.16, 12);
    const innerEarMat = parts.toon(0xf472b6);
    const leftInner = new THREE.Mesh(innerEarGeo, innerEarMat);
    leftInner.position.set(-0.35, 0.50, 0.10);
    leftInner.rotation.z = -0.25;
    const rightInner = new THREE.Mesh(innerEarGeo, innerEarMat);
    rightInner.position.set(0.35, 0.50, 0.10);
    rightInner.rotation.z = 0.25;
    group.add(leftInner);
    group.add(rightInner);

  } else if (characterId === 'cute-bear') {
    // Tan Snout & Round Bear Ears
    const snoutGeo = new THREE.SphereGeometry(0.22, 16, 16);
    snoutGeo.scale(1.2, 0.85, 0.9);
    const snoutMat = new THREE.MeshToonMaterial({ color: 0xfde047 });
    const snoutMesh = new THREE.Mesh(snoutGeo, snoutMat);
    snoutMesh.position.set(0, -0.12, 0.45);
    group.add(snoutMesh);

    const earGeo = new THREE.SphereGeometry(0.16, 16, 16);
    const earMat = headMat;
    const leftEar = new THREE.Mesh(earGeo, earMat);
    leftEar.position.set(-0.4, 0.48, 0.1);
    const rightEar = new THREE.Mesh(earGeo, earMat);
    rightEar.position.set(0.4, 0.48, 0.1);
    group.add(leftEar);
    group.add(rightEar);

    // Inner-ear tan padding (attached to the outer ear fronts).
    const innerBearGeo = new THREE.SphereGeometry(0.08, 12, 10);
    const innerBearMat = parts.toon(0xfde047);
    const leftInnerBear = new THREE.Mesh(innerBearGeo, innerBearMat);
    leftInnerBear.position.set(-0.4, 0.48, 0.20);
    leftInnerBear.scale.set(1, 1, 0.5);
    const rightInnerBear = new THREE.Mesh(innerBearGeo, innerBearMat);
    rightInnerBear.position.set(0.4, 0.48, 0.20);
    rightInnerBear.scale.set(1, 1, 0.5);
    group.add(leftInnerBear);
    group.add(rightInnerBear);

  } else if (characterId === 'stylized-skull') {
    // Sunken Dark Eye Orbit Sockets & Tooth Jaw Plate
    const orbitGeo = new THREE.SphereGeometry(0.13, 16, 16);
    const orbitMat = new THREE.MeshBasicMaterial({ color: 0x0f172a });
    const leftOrbit = new THREE.Mesh(orbitGeo, orbitMat);
    leftOrbit.position.set(-0.18, 0.12, 0.42);
    const rightOrbit = new THREE.Mesh(orbitGeo, orbitMat);
    rightOrbit.position.set(0.18, 0.12, 0.42);
    group.add(leftOrbit);
    group.add(rightOrbit);

    const noseCavityGeo = new THREE.ConeGeometry(0.06, 0.12, 12);
    const noseCavity = new THREE.Mesh(noseCavityGeo, orbitMat);
    noseCavity.rotation.x = Math.PI;
    noseCavity.position.set(0, -0.06, 0.46);
    group.add(noseCavity);

  } else if (characterId === 'superhero') {
    // Royal Blue Domino Mask & Heroic Golden Hair
    const maskGeo = new THREE.BoxGeometry(0.58, 0.2, 0.12);
    const maskMat = new THREE.MeshToonMaterial({ color: 0x1d4ed8 });
    const maskMesh = new THREE.Mesh(maskGeo, maskMat);
    maskMesh.position.set(0, 0.12, 0.44);
    group.add(maskMesh);

    const hairMesh = parts.buildStrandCluster(hairMat, [
      [-0.05, 0.58, 0.22, 0.13, 1.3, 0.8, 0.8, -0.3],
      [0.12, 0.60, 0.18, 0.12, 1.4, 0.75, 0.8, -0.35],
      [0.26, 0.52, 0.10, 0.10, 1.2, 0.9, 0.8, -0.4]
    ]);
    group.add(hairMesh);

  } else if (characterId === 'jester-clown') {
    // 3-Point Jester Hat with Jingle Bells
    const hatGroup = new THREE.Group();
    const pointGeo = new THREE.ConeGeometry(0.14, 0.5, 12);
    const redMat = new THREE.MeshToonMaterial({ color: 0xd92626 });
    const yelMat = new THREE.MeshToonMaterial({ color: 0xeab308 });
    const bellGeo = new THREE.SphereGeometry(0.06, 12, 12);

    const leftPoint = new THREE.Mesh(pointGeo, redMat);
    leftPoint.position.set(-0.35, 0.68, 0);
    leftPoint.rotation.z = -0.5;
    const leftBell = new THREE.Mesh(bellGeo, yelMat);
    leftBell.position.set(-0.48, 0.88, 0);

    const midPoint = new THREE.Mesh(pointGeo, yelMat);
    midPoint.position.set(0, 0.78, 0);
    const midBell = new THREE.Mesh(bellGeo, redMat);
    midBell.position.set(0, 1.02, 0);

    const rightPoint = new THREE.Mesh(pointGeo, redMat);
    rightPoint.position.set(0.35, 0.68, 0);
    rightPoint.rotation.z = 0.5;
    const rightBell = new THREE.Mesh(bellGeo, yelMat);
    rightBell.position.set(0.48, 0.88, 0);

    hatGroup.add(leftPoint, leftBell, midPoint, midBell, rightPoint, rightBell);
    group.add(hatGroup);

    // Clown ruff collar: hides the neck seam as part of the costume.
    const ruffGeo = new THREE.TorusGeometry(0.26, 0.075, 12, 24);
    const ruffMesh = new THREE.Mesh(ruffGeo, yelMat);
    ruffMesh.rotation.x = Math.PI / 2 - 0.1;
    ruffMesh.position.set(0, -0.60, 0.02);
    group.add(ruffMesh);
  }

  // Eyes, brows, nose, ears — symmetric, forward-facing, seated builders.
  // Lash lines only where the design calls for them (girl/woman/clown).
  const lashForCharacter = (characterId === 'toon-girl' || characterId === 'adult-woman')
    ? 0x1c1917 : (characterId === 'jester-clown' ? 0x0284c7 : null);
  const {
    leftEyeGroup,
    rightEyeGroup,
    leftPupilMesh,
    rightPupilMesh
  } = parts.buildEyePair(eyeColor, pupilColor, skinColor, 0.18, 0.12, 0.42, lashForCharacter);
  group.add(leftEyeGroup);
  group.add(rightEyeGroup);

  const { leftBrowMesh, rightBrowMesh } = parts.buildBrows(
    eyebrowColor, 0.18, 0.12, 0.42, BROW_THICKNESS[characterId] || 0.022);
  group.add(leftBrowMesh);
  group.add(rightBrowMesh);

  // Integrated nose except where the design carries its own
  // (visor/snout/cavity characters).
  if (!NOSELESS_CHARACTERS.includes(characterId)) {
    group.add(parts.buildNose(noseColor, characterId === 'jester-clown' ? 0.12 : 0.06));
  }

  // Human ears seated on the head sides (attached, skin material).
  if (EAR_X[characterId] !== undefined) {
    group.add(parts.buildEars(headMat, EAR_X[characterId]));
  }

  // One coherent recessed mouth assembly for all 15 characters.
  let lipColor = 0xc94a4a;
  if (characterId === 'adult-woman') lipColor = 0xe11d48;
  else if (characterId === 'jester-clown') lipColor = 0xd92626;
  else if (characterId === 'cyber-bot') lipColor = 0x0284c7;
  else if (characterId === 'friendly-alien') lipColor = 0x3f6212;
  else if (characterId === 'stylized-skull') lipColor = 0x334155;

  const {
    mouthGroup,
    mouthCavity,
    upperLip,
    lowerLip,
    teethUpper,
    teethLower,
    baseMouth
  } = parts.buildMouthAssembly(lipColor);
  mouthGroup.name = `AvatarMouthGroup_${characterId}`;

  group.add(mouthGroup);

  // Subtle connected neck + collar (shared builder, never a detached cone).
  const { setGroup: neckSetGroup, neckMesh, shirtMesh } = parts.buildNeckSet(headMat, shirtColor);
  group.add(neckSetGroup);

  // Expose morphTarget properties directly on group for easy renderer access
  group.morphTargetDictionary = morphTargetDictionary;
  group.morphTargetInfluences = headMesh.morphTargetInfluences;
  group.userData = {
    characterId,
    characterName: charMeta.name,
    headMesh,
    leftEyeGroup,
    rightEyeGroup,
    leftPupilMesh,
    rightPupilMesh,
    leftBrowMesh,
    rightBrowMesh,
    mouthGroup,
    mouthCavity,
    upperLip,
    lowerLip,
    teethUpper,
    teethLower,
    baseMouth
  };

  return group;
}
