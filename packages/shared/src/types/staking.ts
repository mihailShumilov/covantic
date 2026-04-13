/**
 * Shape returned by `GET /api/staking/:address`. Used by the API route and
 * every frontend consumer so the contract cannot drift.
 */
export interface StakerPositionResponse {
  staker: string;
  amountStaked: number;
  shareBps: number;
  rewardsClaimed: number;
  rewardsPending: number;
  depositedAt: string | null;
  unstakeRequestedAt: string | null;
}
