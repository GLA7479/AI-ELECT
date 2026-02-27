export function nanoid() {
  // simple id (good enough for MVP)
  return (
    Math.random().toString(16).slice(2) + Date.now().toString(16)
  );
}

