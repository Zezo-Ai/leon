import sys
import inspect
from traceback import print_exc
from importlib import import_module

from constants import INTENT_OBJECT
from sdk.params_helper import ParamsHelper


"""
Python skill bridges are also one-shot processes. We flush stdio and exit
explicitly after each action so lingering handles do not stall the core
waiting for the bridge to terminate naturally.
"""
def exit_bridge(code: int) -> None:
    sys.stdout.flush()
    sys.stderr.flush()
    raise SystemExit(code)


def main() -> int:
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

        run_function = getattr(skill_action_module, 'run')
        params_helper = ParamsHelper(params)

        # Inspect to decide how many args to pass
        signature = inspect.signature(run_function)
        param_count = len(signature.parameters)

        if param_count >= 2:
            run_function(params, params_helper)
        elif param_count == 1:
            run_function(params)
        else:
            run_function()
        # End the bridge deterministically once the action completed.
        return 0
    except Exception as e:
        print(f"Error while running {INTENT_OBJECT['skill_name']} skill {INTENT_OBJECT['action_name']} action: {e}")
        print_exc()
        # Let the core read the error output, then exit with a failure code.
        return 1


if __name__ == '__main__':
    try:
        exit_bridge(main())
    except SystemExit:
        raise
    except Exception as e:
        # Print full traceback error report if skills triggers an error from the call stack
        if 'exceptions must derive from BaseException' not in str(e):
            print_exc()
        exit_bridge(1)
