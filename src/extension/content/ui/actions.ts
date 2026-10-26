import type { Draft } from '../../messages';
import type { ViewThread } from '../store';

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
  remove(thread: ViewThread, commentId: string): Promise<void>;
  setResolved(thread: ViewThread, resolved: boolean): Promise<void>;
  retryOp(opId: string): void;
  discardOp(opId: string): void;

  saveDraft(key: string, text: string): void;
  deleteDraft(key: string): void;
  resumeDraft(draft: Draft): void;

  openThread(id: string, opts?: { scroll?: boolean; fromSidebar?: boolean }): void;
  closeCard(): void;
  toggleSidebar(open?: boolean): void;
  setFilter(filter: 'open' | 'resolved'): void;
  copy(text: string): void;
  refresh(): void;
  anchorRect(threadId: string): DOMRect[] | null;
  draftRect(): DOMRect[] | null;
  isOrphan(threadId: string): boolean;
  apiUrl: string;
}
