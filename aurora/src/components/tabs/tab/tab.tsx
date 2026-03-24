import {
  TabTrigger,
  type TabTriggerProps as ArkTabTriggerProps
} from '@ark-ui/react'

import { generateKeyId } from '../../../lib/utils'

export type TabProps = Pick<
  ArkTabTriggerProps,
  'children' | 'value' | 'disabled'
>

export function Tab({
  children,
  value,
  disabled
}: TabProps): React.JSX.Element {
  return (
    <TabTrigger
      key={`aurora-tab_${generateKeyId()}`}
      className="aurora-tab"
      value={value}
      disabled={disabled}
    >
      {children}
    </TabTrigger>
  )
}
