import { describe, expect, it } from 'vitest'
import { listSkills, type SkillFs } from '../../src/main/skillList'

const WS = '/ws-a'
const HOME = '/home/me'

function fakeFs(disk: Record<string, string | string[]>): SkillFs {
  return {
    readdir: (p) => {
      const e = disk[p]
      if (!Array.isArray(e)) throw new Error(`ENOTDIR ${p}`)
      return [...e]
    },
    readFile: (p) => {
      const e = disk[p]
      if (typeof e !== 'string') throw new Error(`EISDIR ${p}`)
      return e
    },
    isDir: (p) => Array.isArray(disk[p]),
    isFile: (p) => typeof disk[p] === 'string'
  }
}

function skill(name: string, body: string): Record<string, string | string[]> {
  return {
    [`${WS}/.claude/skills/${name}`]: ['SKILL.md'],
    [`${WS}/.claude/skills/${name}/SKILL.md`]: body
  }
}

describe('listSkills: what the task field offers after you type / (BB-M16)', () => {
  describe('listSkills (§4.3: the order)', () => {
    it('lists project skills, then project commands, then home — each half alphabetical', () => {
      const fs = fakeFs({
        [`${WS}/.claude/skills`]: ['zeta', 'alpha'],
        ...skill('zeta', '---\nname: zeta\ndescription: Last one\n---'),
        ...skill('alpha', '---\nname: alpha\n---'),
        [`${WS}/.claude/commands`]: ['ship.md', 'build.md'],
        [`${WS}/.claude/commands/ship.md`]: '# ship',
        [`${WS}/.claude/commands/build.md`]: '# build',
        [`${HOME}/.claude/skills`]: ['omega'],
        [`${HOME}/.claude/skills/omega`]: ['SKILL.md'],
        [`${HOME}/.claude/skills/omega/SKILL.md`]: '---\nname: omega\n---',
        [`${HOME}/.claude/commands`]: ['beta.md'],
        [`${HOME}/.claude/commands/beta.md`]: '# beta'
      })
      expect(listSkills(fs, WS, HOME).map((s) => `${s.name} ${s.source}`)).toEqual([
        '/alpha project',
        '/zeta project',
        '/build project',
        '/ship project',
        '/omega home',
        '/beta home'
      ])
    })

    it('drops a home entry whose name a project entry already took', () => {
      const fs = fakeFs({
        [`${WS}/.claude/skills`]: ['ship'],
        ...skill('ship', '---\nname: ship\ndescription: The project one\n---'),
        [`${HOME}/.claude/skills`]: ['ship'],
        [`${HOME}/.claude/skills/ship`]: ['SKILL.md'],
        [`${HOME}/.claude/skills/ship/SKILL.md`]: '---\nname: ship\ndescription: The home one\n---'
      })
      expect(listSkills(fs, WS, HOME)).toEqual([
        { name: '/ship', description: 'The project one', source: 'project' }
      ])
    })

    it('starts every name with a slash, so the field can paste it as typed', () => {
      const fs = fakeFs({
        [`${WS}/.claude/skills`]: ['zeta'],
        ...skill('zeta', '---\nname: zeta\n---'),
        [`${WS}/.claude/commands`]: ['build.md'],
        [`${WS}/.claude/commands/build.md`]: '# build'
      })
      expect(listSkills(fs, WS, HOME).every((s) => s.name.startsWith('/'))).toBe(true)
    })
  })

  describe('listSkills (§4.3: reading one skill file)', () => {
    function only(body: string): { name: string; description?: string } {
      const fs = fakeFs({ [`${WS}/.claude/skills`]: ['the-dir'], ...skill('the-dir', body) })
      const [s] = listSkills(fs, WS, HOME)
      return { name: s.name, description: s.description }
    }

    it('takes the name from the front matter when there is one', () => {
      expect(only('---\nname: koloft.release-dmg\n---').name).toBe('/koloft.release-dmg')
    })

    it('falls back to the folder name when the front matter has none', () => {
      expect(only('# just a heading\n').name).toBe('/the-dir')
    })

    it('strips the quotes around a value', () => {
      expect(only('---\nname: "quoted"\ndescription: \'also quoted\'\n---')).toEqual({
        name: '/quoted',
        description: 'also quoted'
      })
    })

    it('takes only the first line of the description', () => {
      expect(only('---\ndescription: First line\n  and a second\n---').description).toBe(
        'First line'
      )
    })

    it('takes the first line of text under a folded value', () => {
      expect(
        only('---\ndescription: >\n  The folded first line\n  and more\n---').description
      ).toBe('The folded first line')
    })

    it('cuts a long description at 120 characters', () => {
      const long = 'x'.repeat(200)
      expect(only(`---\ndescription: ${long}\n---`).description).toBe('x'.repeat(120))
    })
  })

  describe('listSkills (§4.3: nothing here ever throws)', () => {
    it('contributes nothing for folders that are not there', () => {
      expect(listSkills(fakeFs({}), WS, HOME)).toEqual([])
    })

    it('gives a skill whose file cannot be read its folder name and no description', () => {
      const fs: SkillFs = {
        ...fakeFs({
          [`${WS}/.claude/skills`]: ['broken'],
          [`${WS}/.claude/skills/broken`]: ['SKILL.md'],
          [`${WS}/.claude/skills/broken/SKILL.md`]: 'unreadable'
        }),
        readFile: () => {
          throw new Error('EACCES')
        }
      }
      expect(listSkills(fs, WS, HOME)).toEqual([{ name: '/broken', source: 'project' }])
    })

    it('skips a skills folder entry that has no SKILL.md, and a command that is not .md', () => {
      const fs = fakeFs({
        [`${WS}/.claude/skills`]: ['empty', 'README.md'],
        [`${WS}/.claude/skills/empty`]: [],
        [`${WS}/.claude/skills/README.md`]: '# not a skill',
        [`${WS}/.claude/commands`]: ['notes.txt', 'build.md'],
        [`${WS}/.claude/commands/notes.txt`]: 'hi',
        [`${WS}/.claude/commands/build.md`]: '# build'
      })
      expect(listSkills(fs, WS, HOME)).toEqual([{ name: '/build', source: 'project' }])
    })
  })
})
