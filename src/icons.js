const fs = require('fs');
const path = require('path');

const ICONS_DIR = path.join(__dirname, '..', 'media', 'icons');

const ICON_NAMES = [
  'box', 'chat', 'scissors', 'bolt', 'download', 'refresh', 'pencil',
  'trash', 'paperclip', 'send', 'stop', 'check', 'warning', 'eye',
  'eyeOff', 'image', 'fileText', 'copy', 'insert', 'close', 'play'
];

const ICONS = {};

for (const name of ICON_NAMES) {
  try {
    ICONS[name] = fs.readFileSync(path.join(ICONS_DIR, `${name}.svg`), 'utf8').trim();
  } catch (err) {
    ICONS[name] = '';
  }
}

module.exports = { ICONS };
