/**
 * Obfuscation script: processes src/ -> src-obf/ before electron-builder.
 * Run: node scripts/obfuscate.js
 */
'use strict';

const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src');
const OUT_DIR = path.join(__dirname, '..', 'src-obf');

const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: false,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: false,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};

// Files/dirs to skip obfuscation (copy as-is)
const SKIP_OBFUSCATION = [
  'waPreload.js',    // Electron preload — sensitive context
];

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function copyFileSync(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function obfuscateFile(src, dest) {
  ensureDir(path.dirname(dest));
  const code = fs.readFileSync(src, 'utf8');
  try {
    const result = JavaScriptObfuscator.obfuscate(code, OBFUSCATOR_OPTIONS);
    fs.writeFileSync(dest, result.getObfuscatedCode(), 'utf8');
  } catch (err) {
    console.warn(`  [warn] Failed to obfuscate ${src}, copying as-is: ${err.message}`);
    fs.copyFileSync(src, dest);
  }
}

function processDir(srcDir, outDir) {
  ensureDir(outDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const outPath = path.join(outDir, entry.name);

    if (entry.isDirectory()) {
      processDir(srcPath, outPath);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === '.js' && !SKIP_OBFUSCATION.includes(entry.name)) {
        console.log(`  obfuscate: ${path.relative(SRC_DIR, srcPath)}`);
        obfuscateFile(srcPath, outPath);
      } else {
        // Copy non-JS files (CSS, HTML, images, JSON) as-is
        copyFileSync(srcPath, outPath);
      }
    }
  }
}

// Clean output dir
if (fs.existsSync(OUT_DIR)) {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
}

console.log('Obfuscating src/ -> src-obf/ ...');
processDir(SRC_DIR, OUT_DIR);
console.log('Done. src-obf/ is ready for electron-builder.');
