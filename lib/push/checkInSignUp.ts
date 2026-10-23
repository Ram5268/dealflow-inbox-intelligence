// Brief 48 (PR 5, review round 1): what Check In on the Home page does about push
// notifications [engineering precaution, found in the PR 5 review]. A browser that's
// already signed up sends its sign-up again, every time. The server only refreshes a
// stored one, and a device that was removed in Settings, or refused at the 5-device
// limit, comes back once there's room. (Check In used to stop as soon as the browser
// had a sign-up, so such a device could never get notifications again.) If the server
// refuses it, the browser keeps its sign-up, so the next Check In tries again, and
// Check In says why in a calm toast instead of failing silently. The browser parts
// are passed in, so this is unit-tested.
// The toast is one line and cuts off what doesn't fit (components/Toast.tsx), which
// on a 375 px phone is about 52 characters, so this stays short enough to read whole.
export const CHECK_IN_FULL_MESSAGE = 'Notifications are full. Remove a device in Settings.'

// What a browser push sign-up needs here: the JSON the server stores comes from it.
export interface SignUp { toJSON(): unknown }

export interface CheckInPushDeps<S extends SignUp> {
  publicKey: () => Promise<string>   // '' when push isn't set up on the server
  existing: () => Promise<S | null>  // this browser's sign-up, if it has one
  requestPermission: () => Promise<string>
  subscribe: (publicKey: string) => Promise<S>
  send: (signUp: unknown) => Promise<number> // POST /api/push/subscribe; its HTTP status
}

export type CheckInPushResult =
  | { result: 'not-set-up' | 'no-permission' | 'sent' | 'failed' }
  | { result: 'full'; message: string }

export async function signUpOnCheckIn<S extends SignUp>(d: CheckInPushDeps<S>): Promise<CheckInPushResult> {
  const key = await d.publicKey()
  if (!key) return { result: 'not-set-up' }
  let sub = await d.existing()
  if (!sub) {
    if ((await d.requestPermission()) !== 'granted') return { result: 'no-permission' }
    sub = await d.subscribe(key)
  }
  const status = await d.send(sub.toJSON())
  if (status === 409) return { result: 'full', message: CHECK_IN_FULL_MESSAGE }
  return { result: status >= 200 && status < 300 ? 'sent' : 'failed' }
}
