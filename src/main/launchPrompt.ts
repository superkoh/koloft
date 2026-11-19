export interface LaunchIdentity {
  role: string
  ownerText?: string
}

export const ownerTextOver = (
  own: string | undefined,
  assist: LaunchIdentity | undefined,
  conductor: boolean,
  workspaceText: string | undefined
): string | undefined => own ?? assist?.ownerText ?? (conductor ? undefined : workspaceText)

export const promptParts = (...parts: (string | false | undefined)[]): string[] =>
  parts.filter((part): part is string => !!part)
