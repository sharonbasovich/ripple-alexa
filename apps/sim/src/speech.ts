// Optional voice output via built-in browser speech synthesis.
// Text is always visible; no microphone is ever requested.

let enabled = false;

export function setVoiceEnabled(v: boolean): void {
  enabled = v;
  if (!v && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

export function voiceEnabled(): boolean {
  return enabled;
}

export function speak(text: string): void {
  if (!enabled || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.02;
  u.pitch = 1;
  window.speechSynthesis.speak(u);
}
