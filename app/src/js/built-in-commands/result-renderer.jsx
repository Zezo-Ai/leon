import {
  Flexbox,
  Icon,
  List,
  ListHeader,
  ListItem,
  Text
} from '@aurora'

function ToneListItem({ item }) {
  if (item.tone === 'success') {
    return (
      <ListItem>
        <Flexbox flexDirection="row" alignItems="center" gap="sm">
          <Icon
            iconName="check"
            size="sm"
            type="fill"
            bgShape="circle"
            color="green"
            bgColor="transparent-green"
          />
          <Text>{item.label}</Text>
        </Flexbox>
      </ListItem>
    )
  }

  if (item.tone === 'warning') {
    return (
      <ListItem>
        <Flexbox flexDirection="row" alignItems="center" gap="sm">
          <Icon
            iconName="alert"
            size="sm"
            type="fill"
            bgShape="circle"
            color="yellow"
            bgColor="transparent-yellow"
          />
          <Text>{item.label}</Text>
        </Flexbox>
      </ListItem>
    )
  }

  if (item.tone === 'error') {
    return (
      <ListItem>
        <Flexbox flexDirection="row" alignItems="center" gap="sm">
          <Icon
            iconName="close"
            size="sm"
            type="fill"
            bgShape="circle"
            color="red"
            bgColor="transparent-red"
          />
          <Text>{item.label}</Text>
        </Flexbox>
      </ListItem>
    )
  }

  if (item.value || item.description) {
    return (
      <ListItem>
        <div className="built-in-commands-modal__result-item">
          <div className="built-in-commands-modal__result-copy">
            <Text fontWeight="semi-bold">{item.label}</Text>
            {item.description ? <Text secondary>{item.description}</Text> : null}
          </div>
          {item.value ? (
            <div className="built-in-commands-modal__result-value">
              <Text secondary textAlign="right">
                {item.value}
              </Text>
            </div>
          ) : null}
        </div>
      </ListItem>
    )
  }

  return (
    <ListItem>
      <Text>{item.label}</Text>
    </ListItem>
  )
}

export function BuiltInCommandResultRenderer({ result }) {
  const blocks = Array.isArray(result?.blocks) ? result.blocks : []

  return (
    <Flexbox flexDirection="column" gap="sm">
      {blocks.map((block, index) => {
        if (block.type !== 'list') {
          return null
        }

        const header = block.header || (index === 0 ? result.title : '')

        return (
          <List key={`result-block-${index}`}>
            {header ? <ListHeader>{header}</ListHeader> : null}
            {block.items.map((item, itemIndex) => (
              <ToneListItem item={item} key={`result-item-${itemIndex}`} />
            ))}
          </List>
        )
      })}
    </Flexbox>
  )
}
