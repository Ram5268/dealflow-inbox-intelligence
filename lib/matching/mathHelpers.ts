// Brief 32 — logit-space math for the additive scorer.
//
// The scorer composes features in logit space so that independent evidence adds
// (rather than the old multiplicative model, where one weak feature crushed the
// product and correlated features double-counted). EPS keeps logit finite at the
// 0/1 boundaries: logit(1) ≈ +4.615, logit(0) ≈ -4.615, logit(0.5) = 0.
const EPS = 0.01

export function logit(score: number): number {
  const s = Math.min(1, Math.max(0, score)) // clamp out-of-range input to [0,1]
  return Math.log((s + EPS) / (1 - s + EPS))
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

// Inverse of logit(): the score whose logit is x, clamped to [0,1] (so
// fromLogit(logit(1)) = 1 and fromLogit(logit(0)) = 0).
export function fromLogit(x: number): number {
  const e = Math.exp(x)
  return Math.min(1, Math.max(0, ((1 + EPS) * e - EPS) / (1 + e)))
}
