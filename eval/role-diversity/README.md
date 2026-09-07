# Dask role-diversity experiment

This experiment holds the dataset, base commits, execution mode, and model configuration constant while varying:

1. Role prompt: correctness, performance, security, reliability, maintainability.
2. Planning condition: an independent role Plan or one shared neutral Plan.
3. Optional per-role `prompt_skills` supplied by the experiment config.

The role prompt and `prompt_skills` are included directly in the task instruction sent to the ACP coding Driver. Every role run uses `single_agent` and `B0`, so B Memory retrieval and maintenance do not add hidden Skill or Experience differences.

## Configuration

Copy the example config to a local ignored file and edit each role's `prompt_skills`:

```bash
cp eval/role-diversity/experiment.example.json \
  .newide/experiments/role-diversity/experiment.json
export ROLE_DIVERSITY_CONFIG="$PWD/.newide/experiments/role-diversity/experiment.json"
```

Each prompt Skill has two fields:

```json
{
  "name": "boundary-analysis",
  "instruction": "Enumerate boundary inputs and preserve observable behavior before choosing an implementation."
}
```

Copy `eval/role-diversity/.env.example` to a local file, fill the provider values, and load it in the shell. The runner reads model/API configuration from the environment and contains no credentials.

```bash
set -a
source .newide/experiments/role-diversity/.env
set +a
```

## Run

Run the two-role, one-task pilot:

```bash
pnpm eval:role-diversity -- --pilot
```

Run all 30 role cells and three neutral Plans:

```bash
pnpm eval:role-diversity -- --full
```

Results default to `.newide/experiments/role-diversity/results/<timestamp>/`. Each cell preserves its exact prompt, Persona config, Plan, Driver trajectory, audit, terminal snapshot, patch, Git status, token/timing metadata, and failure details.

Analyze a partial or complete result root:

```bash
pnpm eval:role-diversity:analyze -- \
  .newide/experiments/role-diversity/results/<timestamp>
```
