export function canSendFollowup(state: string, senderId: string, userId: string): boolean {
  return senderId === userId && ['COMPLETED', 'FAILED'].includes(state);
}
