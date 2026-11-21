export interface LaunchIdentity {
  role: string
  ownerText?: string
}

export const ownerPartsOver = (
  own: string | undefined,
  conductor: boolean,
  workspaceParts: readonly string[] | undefined
): string[] =>
  own !== undefined ? (own ? [own] : []) : conductor ? [] : [...(workspaceParts ?? [])]

export const ownerTextOver = (
  own: string | undefined,
  conductor: boolean,
  workspaceParts: readonly string[] | undefined
): string | undefined => ownerPartsOver(own, conductor, workspaceParts).join('\n\n') || undefined

export const promptParts = (...parts: (string | false | undefined)[]): string[] =>
  parts.filter((part): part is string => !!part)
