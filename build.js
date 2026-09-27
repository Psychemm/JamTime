// Bundles PeerJS + src/jamtime.js into the single file Spicetify loads.
const fs = require('fs');
const path = require('path');

const peerjs = fs.readFileSync(require.resolve('peerjs/dist/peerjs.min.js'), 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, '');
const src = fs.readFileSync(path.join(__dirname, 'src', 'jamtime.js'), 'utf8');
const { version } = require('./package.json');
const peerVersion = require('peerjs/package.json').version;

const out = `// NAME: JamTime
// AUTHOR: Psychemm
// VERSION: ${version}
// DESCRIPTION: Spotify Jam for free accounts. Start a jam, share the code, and everyone hears the same song at the same time.
// Built from https://github.com/Psychemm/JamTime (src/jamtime.js). Includes PeerJS ${peerVersion} (MIT).

${peerjs}
${src}`;

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'jamtime.js'), out);
console.log(`Built dist/jamtime.js (${(out.length / 1024).toFixed(0)} KB)`);
