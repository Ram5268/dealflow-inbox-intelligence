import { checkCronBearer } from '../auth/cronBearer'

// Brief 44: POST /api/valuations/import and GET /api/valuations/targets accept only
// `Authorization: Bearer <VALUATION_IMPORT_SECRET>`, compared in constant time
// (checkCronBearer). They fail closed: 500 when the secret is unset or too short to
// be a generated one, 401 on a missing or wrong token. Engineering precaution.
export const MIN_SECRET_LENGTH = 16

export function checkValuationSecret(authorization: string | null, secret: string | undefined): 200 | 401 | 500 {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return 500
  return checkCronBearer(authorization, secret)
}
