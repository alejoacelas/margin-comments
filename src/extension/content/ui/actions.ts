import type { Draft, InputCommand, InputEventType, InputInit } from '../../messages';
import type { ViewThread } from '../store';

/** Viewport geometry of a highlight: its line boxes and its text column's right edge. */
export type AnchorBox = { rects: DOMRect[]; columnRight: number };

/** Everything the UI can ask the controller to do. */
export interface Actions {
  startEmail(email: string): Promise<{ requestId: string; emailMode: string }>;
  verifyCode(requestId: string, code: string): Promise<void>;
  googleSignIn(): Promise<void>;
  signOut(): Promise<void>;
  updateMe(patch: { name?: string; notifyEmail?: boolean }): Promise<void>;

  clickAdder(): void;
  createThread(body: string): Promise<void>;
  cancelComposer(): void;
  reply(thread: ViewThread, commentId: string, body: string, draftKey: string): Promise<void>;
  edit(thread: ViewThread, commentId: string, body: string, draftKey: string): Promise<void>;
  /** An edit starts: remember the text it's based on (kept with its draft). */
  beginEdit(draftKey: string, currentBody: string): void;
  /** An edit was cancelled or sent. */
  endEdit(draftKey: string): void;
  remove(thread: ViewThread, commentId: string): Promise<void>;
  setResolved(thread: ViewThread, resolved: boolean): Promise<void>;
  retryOp(opId: string): void;
  discardOp(opId: string): void;

  saveDraft(key: string, text: string): void;
  /** Latest draft text for a key, including saves not yet confirmed. */
  draftText(key: string): string | undefined;
  deleteDraft(key: string, texts?: string[], opts?: { onlyTexts?: boolean }): void;
  resumeDraft(draft: Draft): void;

  openThread(id: string, opts?: { scroll?: boolean; fromSidebar?: boolean }): void;
  closeCard(): void;
  toggleSidebar(open?: boolean): void;
  setFilter(filter: 'open' | 'resolved'): void;
  /** A short confirmation at the bottom of the screen. */
  toast(message: string): void;
  refresh(): void;
  anchorBox(threadId: string): AnchorBox | null;
  draftBox(): AnchorBox | null;
  isOrphan(threadId: string): boolean;
  apiUrl: string;

  /** Secure text fields (extension-origin frames). */
  inputUrl: string;
  openField(sid: string, init: InputInit, onEvent: (type: InputEventType, value: string) => void, currentValue: () => string): void;
  fieldCommand(sid: string, cmd: InputCommand): void;
  closeField(sid: string): void;
  /** Open (or bring back) the field in its own extension window, where frames can't run. */
  openFieldWindow(sid: string): void;
}
