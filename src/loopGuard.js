// Weak models sometimes get stuck repeating the same text for ever. This finds such a loop in a stream.
const MIN_LENGTH = 700;
const CHECK_EVERY = 150;

// Returns where to cut the text so that only one round of the repetition is kept, or -1 when there is no loop.
function findLoop(text) {
  if (text.length < MIN_LENGTH) return -1;

  // Short phrase repeated again and again.
  for (let p = 8; p <= 120; p++) {
    const tail = text.slice(-p * 8);
    let same = true;
    for (let i = p; i < tail.length; i++) {
      if (tail[i] !== tail[i - p]) {
        same = false;
        break;
      }
    }
    if (same) return text.length - p * 7;
  }

  // A long block (for example three files in a row) written out several times.
  const tail = text.slice(-250);
  const first = text.indexOf(tail);
  if (first === -1 || first + tail.length >= text.length) return -1;
  const second = text.indexOf(tail, first + 1);
  if (second === -1 || second + tail.length >= text.length) return -1;
  const third = text.indexOf(tail, second + 1);
  if (third === -1) return -1;
  return second;
}

// Call with the growing text; remembers when it last looked so it stays cheap.
function makeWatcher() {
  let last = 0;
  return (text) => {
    if (text.length - last < CHECK_EVERY) return -1;
    last = text.length;
    return findLoop(text);
  };
}

module.exports = { findLoop, makeWatcher };
