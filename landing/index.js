// Rotating "Edit your match ___" phrase. All phrases live in the markup (so
// they're in the page text); only one is visible and exposed to screen readers.
const phrases = Array.from(document.querySelectorAll('.rotator .phrase'));
const PHRASE_MS = 2400;

let current = 0;

phrases.forEach((p, i) => p.setAttribute('aria-hidden', i === current ? 'false' : 'true'));

function nextPhrase() {
  const outgoing = phrases[current];
  current = (current + 1) % phrases.length;
  const incoming = phrases[current];

  outgoing.classList.remove('is-active');
  outgoing.classList.add('is-leaving');
  outgoing.setAttribute('aria-hidden', 'true');

  incoming.classList.add('is-active');
  incoming.setAttribute('aria-hidden', 'false');

  // Once the leave animation finishes, park the old phrase back below the box
  // without animating, ready for its next turn.
  setTimeout(() => {
    outgoing.style.transition = 'none';
    outgoing.classList.remove('is-leaving');
    outgoing.offsetHeight;
    outgoing.style.transition = '';
  }, 500);
}

if (phrases.length > 1) setInterval(nextPhrase, PHRASE_MS);
