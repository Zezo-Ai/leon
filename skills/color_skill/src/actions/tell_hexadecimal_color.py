from bridges.python.src.sdk.leon import leon
from bridges.python.src.sdk.types import ActionParams
from ..lib import hexa_colors


def run(params: ActionParams) -> None:
    """Leon tells a hexadecimal color code"""

    try:
        entities = params['entities']

        # Find entities
        for item in entities:
            if item['entity'] == 'color':
                color_name = item['resolution']['value']

                return leon.answer({
                    'key': 'hexa_code_found',
                    'data': {
                        'color_name': color_name,
                        'hexa_code': hexa_colors.MAP[color_name]
                    }
                })

        return leon.answer({
            'key': 'unknown'
        })
    except BaseException:
        return leon.answer({'key': 'not_found'})
