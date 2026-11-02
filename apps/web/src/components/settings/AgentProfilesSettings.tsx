import { AgentProfileId, type AgentProfile } from "@t3tools/contracts/settings";
import { useState } from "react";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsSection } from "./settingsLayout";

const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;

export function AgentProfilesSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const providersByEnvironment = useEnvironmentProviders();
  const { environment, scope } = useSettingsScope();
  const providers =
    (environment ? providersByEnvironment.get(environment.environmentId) : undefined) ??
    EMPTY_SERVER_PROVIDERS;
  const profiles = settings.agentProfiles;
  const [editingId, setEditingId] = useState<AgentProfileId | null>(null);
  const [draft, setDraft] = useState<AgentProfile | null>(null);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const selectedIds = settings.agentProfileIds ?? Object.keys(profiles);

  const edit = (id: AgentProfileId, profile: AgentProfile) => {
    setEditingId(id);
    setDraft(profile);
  };

  const save = () => {
    if (editingId === null || draft === null) return;
    updateSettings({ agentProfiles: { [editingId]: draft } });
    setEditingId(null);
    setDraft(null);
  };

  const setProjectProfileEnabled = (id: AgentProfileId, enabled: boolean) => {
    const next = new Set(selectedIds);
    if (enabled) next.add(id);
    else next.delete(id);
    updateSettings({ agentProfileIds: [...next] });
  };

  return (
    <SettingsSection id="agent-profiles" title="Agent profiles">
      <p className="mb-3 text-sm text-muted-foreground">
        Reusable roles combine instructions, a provider model, and a runtime mode. Projects can
        choose which profiles their orchestration may use.
      </p>
      {Object.entries(profiles).map(([id, profile]) => (
        <div key={id} className="mb-2 flex items-center gap-2 rounded-lg border p-3">
          {isProjectScope ? (
            <input
              type="checkbox"
              checked={selectedIds.includes(id as AgentProfileId)}
              disabled={settings.securityReviewerProfileId === id}
              onChange={(event) =>
                setProjectProfileEnabled(id as AgentProfileId, event.currentTarget.checked)
              }
              aria-label={`Allow ${profile.name} in this project`}
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="font-medium">{profile.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {profile.modelSelection.instanceId} · {profile.modelSelection.model}
            </div>
          </div>
          {!isProjectScope ? (
            <>
              <Button size="xs" variant="ghost" onClick={() => edit(id as AgentProfileId, profile)}>
                Edit
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => updateSettings({ agentProfiles: { [id]: null } })}
              >
                Remove
              </Button>
            </>
          ) : null}
        </div>
      ))}
      {isProjectScope ? (
        <div className="mt-3 grid gap-2">
          <label className="text-sm font-medium" htmlFor="security-reviewer-profile">
            Required security reviewer
          </label>
          <select
            id="security-reviewer-profile"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={settings.securityReviewerProfileId ?? ""}
            onChange={(event) => {
              const id = event.currentTarget.value as AgentProfileId;
              if (id) updateSettings({ securityReviewerProfileId: id });
            }}
          >
            <option value="" disabled>
              Select a reviewer profile
            </option>
            {Object.entries(profiles)
              .filter(([id]) => selectedIds.includes(id as AgentProfileId))
              .map(([id, profile]) => (
                <option key={id} value={id}>
                  {profile.name}
                </option>
              ))}
          </select>
          <p className="text-xs text-muted-foreground">
            T3 requires this profile to review the exact selected changes before its commit action.
            Select a new reviewer before removing the current one.
          </p>
        </div>
      ) : null}
      {!isProjectScope && editingId !== null && draft !== null ? (
        <div className="mt-3 grid gap-2 rounded-lg border p-3">
          <Input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
            aria-label="Agent profile name"
            placeholder="Security reviewer"
          />
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={draft.modelSelection.instanceId}
            onChange={(event) => {
              const provider = providers.find(
                (item) => item.instanceId === event.currentTarget.value,
              );
              const model = provider?.models[0]?.slug ?? draft.modelSelection.model;
              setDraft({
                ...draft,
                modelSelection: {
                  instanceId: event.currentTarget
                    .value as AgentProfile["modelSelection"]["instanceId"],
                  model,
                },
              });
            }}
            aria-label="Agent profile provider"
          >
            {providers
              .filter((provider) => provider.enabled)
              .map((provider) => (
                <option key={provider.instanceId} value={provider.instanceId}>
                  {provider.displayName ?? provider.driver}
                </option>
              ))}
          </select>
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={draft.modelSelection.model}
            onChange={(event) =>
              setDraft({
                ...draft,
                modelSelection: { ...draft.modelSelection, model: event.currentTarget.value },
              })
            }
            aria-label="Agent profile model"
          >
            {providers
              .find((provider) => provider.instanceId === draft.modelSelection.instanceId)
              ?.models.map((model) => (
                <option key={model.slug} value={model.slug}>
                  {model.name}
                </option>
              ))}
          </select>
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={draft.runtimeMode}
            onChange={(event) =>
              setDraft({
                ...draft,
                runtimeMode: event.currentTarget.value as AgentProfile["runtimeMode"],
              })
            }
            aria-label="Agent profile runtime mode"
          >
            {RUNTIME_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
          <Textarea
            value={draft.instructions}
            onChange={(event) => setDraft({ ...draft, instructions: event.currentTarget.value })}
            aria-label="Agent profile instructions"
            placeholder="Instructions for this role"
            rows={6}
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditingId(null);
                setDraft(null);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={save}
              disabled={!draft.name.trim() || !draft.modelSelection.model.trim()}
            >
              Save profile
            </Button>
          </div>
        </div>
      ) : null}
      {!isProjectScope ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => {
            const provider = providers.find((item) => item.enabled && item.models.length > 0);
            if (!provider) return;
            // @effect-diagnostics-next-line cryptoRandomUUID:off -- The UI event handler has no Effect runtime context.
            const id = `agent-${crypto.randomUUID()}` as AgentProfileId;
            edit(id, {
              name: "New agent",
              instructions: "",
              modelSelection: { instanceId: provider.instanceId, model: provider.models[0]!.slug },
              runtimeMode: "approval-required",
            });
          }}
          disabled={!providers.some((provider) => provider.enabled && provider.models.length > 0)}
        >
          Add agent profile
        </Button>
      ) : null}
    </SettingsSection>
  );
}
