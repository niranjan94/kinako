const SIDE_QUESTION_START_EVENT = "t3:side-question-start";

export function requestSideQuestionStart(): void {
  window.dispatchEvent(new Event(SIDE_QUESTION_START_EVENT));
}

export function subscribeSideQuestionStart(listener: () => void): () => void {
  window.addEventListener(SIDE_QUESTION_START_EVENT, listener);
  return () => window.removeEventListener(SIDE_QUESTION_START_EVENT, listener);
}
