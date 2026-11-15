// Rendered to HTML in plain Node: enough to check which steps and commands
// the welcome screen shows for each state of the AWS CLI.

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AwsCliStatus } from '../../shared/types'
import { SetupStepsView } from './SetupSteps'

const noop = () => {}
const render = (cli: AwsCliStatus | null) =>
  renderToStaticMarkup(<SetupStepsView cli={cli} checking={false} onCheckAgain={noop} onOpenGuide={noop} />)
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

describe('SetupStepsView', () => {
  it('asks for the AWS CLI to be installed when it is not, with the command and the guide', () => {
    const page = text(render({ installed: false, version: null }))
    expect(page).toContain('The AWS CLI is not installed on this computer.')
    expect(page).toContain('winget install --exact --id Amazon.AWSCLI')
    expect(page).toContain('Open the Install Guide…')
  })

  it('marks the install step done, in words, when the CLI is there', () => {
    const page = text(render({ installed: true, version: '2.17.3' }))
    expect(page).toContain('Done: version 2.17.3 of the AWS CLI is installed.')
    expect(page).not.toContain('winget')
    expect(page).not.toContain('Open the Install Guide…')
  })

  it('says it is still looking before the check has answered', () => {
    const page = text(render(null))
    expect(page).toContain('Checking for the AWS CLI…')
    expect(page).not.toContain('winget')
  })

  it.each([
    [{ installed: false, version: null }],
    [{ installed: true, version: '2.17.3' }]
  ])('always shows both ways to create a profile, and the way back: %j', (cli) => {
    const page = text(render(cli))
    expect(page).toContain('aws configure ')
    expect(page).toContain('aws configure sso')
    expect(page).toContain('read-only policy')
    expect(page).toContain('Check Again')
  })

  it('numbers the steps as a list, so a screen reader announces them in order', () => {
    const html = render({ installed: false, version: null })
    expect(html).toMatch(/^<section[^>]*aria-labelledby="setup-title"/)
    expect(html.match(/<li/g)).toHaveLength(3)
  })
})
