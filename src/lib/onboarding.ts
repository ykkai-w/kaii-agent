export const ONBOARDING_KEY = "kaii.onboarding.v1";
export type OnboardingChoice = "browse" | "configured";

export function readOnboardingChoice(storage: Pick<Storage, "getItem">): OnboardingChoice | null {
  try {
    const value = storage.getItem(ONBOARDING_KEY);
    return value === "browse" || value === "configured" ? value : null;
  } catch {
    return null;
  }
}

export function rememberOnboardingChoice(storage: Pick<Storage, "setItem">, choice: OnboardingChoice) {
  try { storage.setItem(ONBOARDING_KEY, choice); } catch { /* 当前窗口仍可继续使用。 */ }
}

export function hasCloudProvider(providers: { cloud: boolean; configured: boolean }[]) {
  return providers.some((provider) => provider.cloud && provider.configured);
}

export function isBrowsingWithoutModel(
  choice: OnboardingChoice | null,
  providers: { cloud: boolean; configured: boolean }[],
  localReady: boolean,
) {
  return choice === "browse" && !hasCloudProvider(providers) && !localReady;
}

export function onboardingKeyError(raw: string): string | null {
  const key = raw.trim();
  if (!key) return "先粘贴所选服务的 API key。";
  if (key.length < 8 || key.length > 400 || /[\s\u0000-\u001f\u007f]/.test(key)) {
    return "请检查 key 的长度和内容，再试一次。";
  }
  return null;
}
