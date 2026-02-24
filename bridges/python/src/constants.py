import sys
import json
import os

import version

argv = sys.argv[1:]
if "--runtime" in argv:
    runtime_index = argv.index("--runtime")
    argv = [
        arg
        for index, arg in enumerate(argv)
        if index not in (runtime_index, runtime_index + 1)
    ]

INTENT_OBJ_FILE_PATH = argv[0] if argv else None
if not INTENT_OBJ_FILE_PATH:
    raise Exception("Missing intent object path for skill runtime.")

with open(INTENT_OBJ_FILE_PATH, "r", encoding="utf-8") as f:
    INTENT_OBJECT = json.load(f)

SKILLS_ROOT_PATH = os.path.join(os.getcwd(), "skills")
BIN_PATH = os.path.join(os.getcwd(), "bin")
BRIDGES_PATH = os.path.join(os.getcwd(), "bridges")

NVIDIA_LIBS_PATH = os.path.join(BIN_PATH, "nvidia")

PYTORCH_PATH = os.path.join(BIN_PATH, "pytorch")
PYTORCH_TORCH_PATH = os.path.join(PYTORCH_PATH, "torch")

TOOLKITS_PATH = os.path.join(BRIDGES_PATH, "toolkits")

SKILL_PATH = os.path.join(SKILLS_ROOT_PATH, INTENT_OBJECT["skill_name"])

SKILLS_PATH = SKILLS_ROOT_PATH

SKILL_LOCALE_PATH = os.path.join(
    SKILL_PATH, "locales", f"{INTENT_OBJECT['extra_context']['lang']}.json"
)
if INTENT_OBJECT["skill_name"] and os.path.exists(SKILL_LOCALE_PATH):
    with open(SKILL_LOCALE_PATH, "r", encoding="utf-8") as f:
        SKILL_LOCALE_CONFIG_CONTENT = json.load(f)
else:
    SKILL_LOCALE_CONFIG_CONTENT = {
        "variables": {},
        "common_answers": {},
        "widget_contents": {},
        "actions": {INTENT_OBJECT["action_name"]: {}},
    }

SKILL_LOCALE_CONFIG = (
    SKILL_LOCALE_CONFIG_CONTENT.get("actions", {})
    .get(INTENT_OBJECT["action_name"], {})
    .copy()
)
SKILL_LOCALE_CONFIG["variables"] = SKILL_LOCALE_CONFIG_CONTENT.get("variables", {})
SKILL_LOCALE_CONFIG["common_answers"] = SKILL_LOCALE_CONFIG_CONTENT.get(
    "common_answers", {}
)
SKILL_LOCALE_CONFIG["widget_contents"] = SKILL_LOCALE_CONFIG_CONTENT.get(
    "widget_contents", {}
)

LEON_VERSION = os.getenv("npm_package_version")

PYTHON_BRIDGE_VERSION = version.__version__
