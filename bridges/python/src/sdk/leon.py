import random
import sys
from typing import Union, Dict, Any
from time import sleep
import json

from .aurora.widget_wrapper import WidgetWrapper
from .types import AnswerInput, AnswerData, AnswerConfig
from .widget_component import SUPPORTED_WIDGET_EVENTS
from ..constants import SKILL_LOCALE_CONFIG, INTENT_OBJECT


class Leon:
    instance: 'Leon' = None

    def __init__(self) -> None:
        if not Leon.instance:
            Leon.instance = self

    @staticmethod
    def _inject_variables(answer: AnswerConfig, data_to_inject: Union[Dict[str, Any], None]) -> AnswerConfig:
        """A private helper to inject variables into an answer string or object"""
        if not data_to_inject:
            return answer

        for key, value in data_to_inject.items():
            if isinstance(answer, str):
                answer = answer.replace(f"{{{{ {key} }}}}", str(value))
            elif isinstance(answer, dict):
                if 'text' in answer and answer['text']:
                    answer['text'] = answer['text'].replace(f"{{{{ {key} }}}}", str(value))
                if 'speech' in answer and answer['speech']:
                    answer['speech'] = answer['speech'].replace(f"{{{{ {key} }}}}", str(value))

        return answer

    def set_answer_data(self, answer_key: str, data: Union[AnswerData, None] = None) -> Union[str, AnswerConfig]:
        """
        Apply data to the answer
        :param answer_key: The answer key
        :param data: The data to apply
        """
        try:
            # Prioritize skill-specific answers, then fall back to common answers
            answers_config = SKILL_LOCALE_CONFIG.get('answers', {}).get(answer_key) or \
                             SKILL_LOCALE_CONFIG.get('common_answers', {}).get(answer_key)

            # In case the answer key is not found or is a raw answer
            if not answers_config:
                return answer_key

            # Pick a random answer if it's a list
            answer = random.choice(answers_config) if isinstance(answers_config, list) else answers_config

            # Inject variables from the data parameter and from the global variables config
            answer = self._inject_variables(answer, data)
            answer = self._inject_variables(answer, SKILL_LOCALE_CONFIG.get('variables'))

            return answer
        except Exception as e:
            print(f'Error while setting answer data. Please verify that the answer key "{answer_key}" exists in the locale configuration. Details:', e)
            raise e

    def answer(self, answer_input: AnswerInput) -> None:
        """
        Send an answer to the core
        :param answer_input: The answer input
        """
        try:
            key = answer_input.get('key')
            output = {
                'output': {
                    'codes': 'widget' if answer_input.get('widget') and not answer_input.get('key') else answer_input.get('key'),
                    'answer': self.set_answer_data(key, answer_input.get('data')) if key is not None else '',
                    'core': answer_input.get('core')
                }
            }

            widget = answer_input.get('widget')
            if widget is not None:
                wrapper_props = widget.wrapper_props if widget.wrapper_props else {}
                output['output']['widget'] = {
                    'actionName': f"{INTENT_OBJECT['skill_name']}:{INTENT_OBJECT['action_name']}",
                    'widget': widget.widget,
                    'id': widget.id,
                    'onFetch': widget.on_fetch if hasattr(widget, 'on_fetch') else None,
                    'componentTree': WidgetWrapper({
                        **wrapper_props,
                        'children': [widget.render()]
                    }).__dict__(),
                    'supportedEvents': SUPPORTED_WIDGET_EVENTS
                }

            answer_object = {
                **INTENT_OBJECT,
                **output
            }

            # "Temporize" for the data buffer output on the core
            sleep(0.1)

            # Write the answer object to stdout as a JSON string with a newline for brain chunk-by-chunk parsing
            sys.stdout.write(json.dumps(answer_object) + '\n')
            sys.stdout.flush()

        except Exception as e:
            print('Error while creating answer:', e)
            if 'not JSON serializable' in str(e):
                return print("Hint: make sure that widget children components are a list. "
                             "E.g. { 'children': [Text({ 'children': 'Hello' })] }")


leon = Leon()
