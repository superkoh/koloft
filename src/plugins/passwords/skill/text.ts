import type { TextBlock } from '@core/plugin'

export const TEXT: readonly TextBlock[] = [
  {
    slot: 'koloft-skill-passwords',
    text: ', or get a password, code or sign-in from the owner (sudo, a web page field, a sign-in that ends on localhost)'
  },
  {
    slot: 'koloft-help-passwords',
    text: `

PASSWORDS, CODES, SIGN-INS AND ROBOT CHECKS

When a step needs the owner's password or a one-time code, Koloft asks the owner for it in this session's tab in Koloft (a web page or sign-in in this session's Workbench){{koloft-help-passwords-away}}. Koloft passes it on itself: you never see it. Never ask the owner to write a password or code in a message.

sudo
    In a command with no terminal, Koloft's sudo asks the owner for the password. In a Codex, Muse or Antigravity session, and in any session on another machine, it asks also when the command has a terminal of its own.{{koloft-help-sudo-away}} Each new command asks again, so put all the sudo steps in one command line. A script that runs /usr/bin/sudo itself cannot be answered. Inside the Codex sandbox sudo cannot run at all. In a Muse session, sudo failing with "Operation not permitted" means the Muse sandbox stopped it: run the command again with sandbox_permissions "require_escalated"; the owner allows that first, then Koloft asks for the password.
    Example: sudo brew services restart nginx && sudo launchctl kickstart -k system/com.example

koloft secret page <css selector>
    The owner types a password or code into one field of a page in this session's Workbench browser: into the page itself at the Mac{{koloft-help-secret-page-away}}. The selector must match exactly one input box in one open page. Then look at the page to see what happened. Only for passwords and codes: fill other fields yourself.
    Example: koloft secret page "input[type=password]"

koloft secret url "<sign-in address>"
    For a sign-in that a command line tool starts in a browser and that ends on a 127.0.0.1 or localhost address, like codex login. Start the tool in the background first and give its sign-in address. Koloft opens it in this session's Workbench, where the owner can finish it{{koloft-help-secret-url-away}}. Prefer a tool's device code sign-in when it has one: then just tell the owner the address and the code.
    Example: koloft secret url "https://auth.openai.com/oauth/authorize?..."

koloft page tap <css selector> -- "<one line that tells the owner what to do>"
    For a robot check ("I'm not a robot", a picture puzzle) or anything else on a page in this session's Workbench browser that only the owner may click. Never click such a check yourself: hand it to the owner. At the Mac the page comes to the front and the owner clicks it{{koloft-help-page-tap-away}}. The selector must match exactly one element in one open page: the smallest one that holds the check, usually its <iframe>. Then look at the page to see what happened.
    Example: koloft page tap "iframe[title='reCAPTCHA']" -- "Tick the I'm not a robot box."`
  }
]
