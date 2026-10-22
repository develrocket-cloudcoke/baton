const DELEGATABLE_STATES = new Set(['ACCEPTED', 'READY_TO_RUN', 'RUNNING', 'RESULT_REVIEW']);

export function canCreateDelegation(state: string, recipientTeamId: string, myTeamIds: string[]): boolean {
  return DELEGATABLE_STATES.has(state) && myTeamIds.includes(recipientTeamId);
}
