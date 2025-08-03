import sys
from traceback import print_exc
from importlib import import_module

from constants import INTENT_OBJECT
from params_helper import ParamsHelper


def main():
    params = {
        'lang': INTENT_OBJECT['lang'],
        'utterance': INTENT_OBJECT['utterance'],
        'action_arguments': INTENT_OBJECT['action_arguments'],
        'entities': INTENT_OBJECT['entities'],
        'sentiment': INTENT_OBJECT['sentiment'],
        'context_name': INTENT_OBJECT['context_name'],
        'skill_name': INTENT_OBJECT['skill_name'],
        'action_name': INTENT_OBJECT['action_name'],
        'context': INTENT_OBJECT['context'],
        'skill_config': INTENT_OBJECT['skill_config'],
        'skill_config_path': INTENT_OBJECT['skill_config_path'],
        'extra_context': INTENT_OBJECT['extra_context']
    }

    try:
        sys.path.append('.')

        skill_action_module = import_module(
            'skills.'
            + INTENT_OBJECT['skill_name']
            + '.src.actions.'
            + INTENT_OBJECT['action_name']
        )

        params_helper = ParamsHelper(params)

        getattr(skill_action_module, 'run')(params, params_helper)
    except Exception as e:
        print(f"Error while running {INTENT_OBJECT['skill_name']} skill {INTENT_OBJECT['action_name']} action: {e}")
        print_exc()


if __name__ == '__main__':
    try:
        raise main()
    except Exception as e:
        # Print full traceback error report if skills triggers an error from the call stack
        if 'exceptions must derive from BaseException' not in str(e):
            print_exc()
