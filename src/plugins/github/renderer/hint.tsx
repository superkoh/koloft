import { Pic, type HintWords } from '@renderer/components/hintPic'

export const GITHUB_BUTTON_PART = 'github-button'

export const GITHUB_HINT: HintWords = {
  title: 'This project is on GitHub',
  body: (
    <>
      The number is this branch&apos;s <b>pull request</b>. Click to read it here;
      <b> right-click</b> for the repository and the pull-request list.
    </>
  ),
  pic: (
    <Pic h={44} label="the tab strip's GitHub button">
      <g>
        <rect x="11.5" y="12.5" width="60" height="19" rx="6" fill="none" stroke="var(--line)" />
        <text x="28" y="25" className="pt" fill="var(--fg-dim)">
          Files
        </text>
        <rect x="78" y="12.5" width="52" height="19" rx="6" fill="var(--bg-3)" />
        <circle cx="90" cy="22" r="6" fill="var(--fg-dim)" />
        <text x="101" y="25" className="pt-mono" fill="var(--fg)">
          #265
        </text>
        <path d="M140 13 v18" stroke="var(--line-2)" strokeWidth="1" />
      </g>
    </Pic>
  )
}
