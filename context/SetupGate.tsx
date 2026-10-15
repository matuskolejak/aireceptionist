import { createContext, useContext } from 'react';

/**
 * Lets the onboarding funnel tell the root routing gate that setup is finished.
 *
 * The root layout (app/_layout.tsx) probes `done` once per signed-in account,
 * keyed on the user id, and its Stack.Protected guards only open the tabs once
 * the flag is true. Completing the funnel never changes the account, so without
 * a way to flip the flag from inside the funnel the tabs would stay locked and
 * the funnel would stay the only reachable screen until the next launch.
 * Flipping it is all the funnel has to do: the guards swap the funnel for the
 * tabs on their own.
 *
 * It lives in its own module rather than as an export of app/_layout.tsx so two
 * route files loaded through expo-router's require-context never import each
 * other.
 */
export const SetupGateContext = createContext<{ markSetupDone: () => void }>({
  markSetupDone: () => {},
});

export const useSetupGate = () => useContext(SetupGateContext);
