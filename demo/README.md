# Demo: installing and using pi-ard in Pi

![pi-ard demo](pi-ard.gif)

[`pi-ard.cast`](pi-ard.cast) is an [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/) recording of a real session, 86 s long. Play it with `asciinema play demo/pi-ard.cast`, or render it with [`agg`](https://github.com/asciinema/agg).

What happens in it:

1. `pi install git:github.com/zeroasterisk/pi-ard`, then `pi list`.
2. `/ard` shows the configured registry and trusted domains.
3. "Find a Hugging Face skill for fine-tuning a language model": the model calls `ard_search` against live Hugging Face Discover.
4. "Install the huggingface-llm-trainer skill": `ard_install` raises Pi's confirm dialog, and the user picks Yes. The result reports the 18 bundled files that `SKILL.md` cites but that were not installed.
5. "Add the official Hugging Face MCP server": the filtered search finds nothing, so the model reads `huggingface.co`'s catalog instead (the live registry also returns a referral, printed as a `searchUrl` config line). `ard_install` confirms, and the server is registered for the session.
6. `/quit`, then the installed `SKILL.md` on disk.

## Nothing is staged

[`record.py`](record.py) runs a real bash in a real PTY and records every byte. It only types keystrokes, and it waits for the screen to show a prompt or dialog before typing the next one. The model is real (Claude Opus behind an OpenAI-compatible proxy, configured in Pi's `models.json`), the registry is live, and the answers are the model's own. There is no Google Cloud and no OpenCode; any model Pi supports works.

Re-record it yourself with a throwaway home, so nothing from your machine appears on screen:

```sh
export HOME=$(mktemp -d) && mkdir -p ~/.pi/agent/pi-ard
cp <your models.json> ~/.pi/agent/   # any Pi-supported model
echo '{"defaultProvider":"<provider>","defaultModel":"<model>","quietStartup":true}' > ~/.pi/agent/settings.json
echo '{"trustedDomains":["huggingface.co","github.com","raw.githubusercontent.com"]}' > ~/.pi/agent/pi-ard/config.json
python3 demo/record.py demo/pi-ard.cast
agg --theme monokai --idle-time-limit 2 --speed 1.25 demo/pi-ard.cast demo/pi-ard.gif
```

The model's wording varies between runs, but the tool calls, confirm dialogs and results do not.
