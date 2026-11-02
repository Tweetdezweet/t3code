import {
  AgentProfileId,
  AuthSettingsWriteScope,
  type AgentProfile,
  type AgentProfileInstructionVersion,
  type AgentProfileSyncState,
  type EnvironmentId,
  type ProfileServiceSnapshot,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsSection } from "./settingsLayout";

interface RemoteProfile extends ProfileServiceSnapshot {
  readonly profileId: string;
  readonly version: number;
}

interface RemoteInstruction {
  readonly instructionId: string;
  readonly level: "global" | "group";
  readonly name: string;
  readonly version: number;
  readonly content: string;
}

interface ProfileGrant {
  readonly subjectId: string;
  readonly role: "read" | "use" | "edit";
}

interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly etag?: string;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The profile service returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

function items<T>(body: unknown): readonly T[] {
  const value = record(body).items;
  if (!Array.isArray(value)) throw new Error("The profile service response is missing items.");
  return value as readonly T[];
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.length > 0) return body;
  if (body !== null && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
  }
  if (body !== null && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") return error;
  }
  return fallback;
}

function reportFailure(result: { readonly _tag: string }) {
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result as never)) return "The request was cancelled.";
    const failure = squashAtomCommandFailure(result as never);
    return failure instanceof Error ? failure.message : "The request failed.";
  }
  return "The request failed.";
}

export function AgentProfileCatalogSettings({
  environmentId,
  settings,
}: {
  readonly environmentId: EnvironmentId;
  readonly settings: ServerSettings;
}) {
  const providersByEnvironment = useEnvironmentProviders();
  const providers = providersByEnvironment.get(environmentId) ?? [];
  const request = useAtomCommand(serverEnvironment.agentProfileServiceRequest, {
    reportFailure: false,
  });
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const connection = settings.agentProfileService;
  const syncStates = settings.agentProfileSyncState;
  const [endpoint, setEndpoint] = useState(connection.endpoint);
  const [token, setToken] = useState("");
  const [remoteProfiles, setRemoteProfiles] = useState<readonly RemoteProfile[]>([]);
  const [remoteInstructions, setRemoteInstructions] = useState<readonly RemoteInstruction[]>([]);
  const [editing, setEditing] = useState<RemoteProfile | null>(null);
  const [draft, setDraft] = useState<ProfileServiceSnapshot | null>(null);
  const [editingLocalOverride, setEditingLocalOverride] = useState(false);
  const [conflict, setConflict] = useState<RemoteProfile | null>(null);
  const [newProfile, setNewProfile] = useState({
    name: "",
    description: "",
    instructions: "",
    preferredProvider: "",
    preferredModel: "",
  });
  const [newInstruction, setNewInstruction] = useState({
    level: "global" as "global" | "group",
    name: "",
    content: "",
  });
  const [editingInstruction, setEditingInstruction] = useState<RemoteInstruction | null>(null);
  const [instructionDraft, setInstructionDraft] = useState({ name: "", content: "" });
  const [instructionHistory, setInstructionHistory] = useState<readonly Record<string, unknown>[]>(
    [],
  );
  const [instructionHistoryTarget, setInstructionHistoryTarget] =
    useState<RemoteInstruction | null>(null);
  const [sharingProfileId, setSharingProfileId] = useState<string | null>(null);
  const [shareSubject, setShareSubject] = useState("");
  const [shareRole, setShareRole] = useState<"read" | "use" | "edit">("use");
  const [grants, setGrants] = useState<readonly ProfileGrant[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const call = async (
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<ApiResponse> => {
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      throw new Error("This connection cannot access profile service settings.");
    }
    const result = await request({
      environmentId,
      input: { method, path, ...(body === undefined ? {} : { body }) },
    });
    if (result._tag === "Failure") throw new Error(reportFailure(result));
    return result.value;
  };

  const markSyncStatus = async (
    profileId: AgentProfileId,
    status: AgentProfileSyncState["status"],
  ) => {
    const sync = syncStates[profileId];
    if (!sync) return;
    const result = await update({
      environmentId,
      input: { patch: { agentProfileSyncState: { [profileId]: { ...sync, status } } } },
    });
    if (result._tag === "Failure") throw new Error(reportFailure(result));
  };

  const saveConnection = async () => {
    setPending(true);
    setMessage(null);
    try {
      const result = await update({
        environmentId,
        input: {
          patch: {
            agentProfileService: {
              endpoint: endpoint.trim(),
              ...(token.trim() ? { accessToken: token.trim(), credentialConfigured: true } : {}),
            },
          },
        },
      });
      if (result._tag === "Failure") throw new Error(reportFailure(result));
      setToken("");
      setMessage("Connection settings saved. Refresh the catalog to verify access.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save connection settings.");
    } finally {
      setPending(false);
    }
  };

  const clearConnection = async () => {
    setPending(true);
    try {
      const result = await update({
        environmentId,
        input: {
          patch: {
            agentProfileService: {
              endpoint: "",
              accessToken: "",
              credentialConfigured: false,
            },
          },
        },
      });
      if (result._tag === "Failure") throw new Error(reportFailure(result));
      setEndpoint("");
      setToken("");
      setRemoteProfiles([]);
      setRemoteInstructions([]);
      setMessage("Profile service disconnected.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not disconnect.");
    } finally {
      setPending(false);
    }
  };

  const refreshCatalog = async () => {
    setPending(true);
    setMessage(null);
    try {
      const [profilesResponse, instructionsResponse] = await Promise.all([
        call("GET", "/v1/profiles"),
        call("GET", "/v1/instructions"),
      ]);
      if (profilesResponse.status >= 400) {
        throw new Error(errorMessage(profilesResponse.body, "Could not load remote profiles."));
      }
      if (instructionsResponse.status >= 400) {
        throw new Error(
          errorMessage(instructionsResponse.body, "Could not load shared instructions."),
        );
      }
      const profiles = items<RemoteProfile>(profilesResponse.body);
      setRemoteProfiles(profiles);
      setRemoteInstructions(items<RemoteInstruction>(instructionsResponse.body));

      const remoteIds = new Set(profiles.map((profile) => profile.profileId));
      for (const [id, sync] of Object.entries(syncStates)) {
        if (sync.status !== "synced" || remoteIds.has(sync.remoteProfileId)) continue;
        const detail = await call(
          "GET",
          `/v1/profiles/${encodeURIComponent(sync.remoteProfileId)}`,
        );
        if (detail.status === 410) {
          await markSyncStatus(AgentProfileId.make(id), "archived");
        } else if (detail.status >= 400) {
          await markSyncStatus(AgentProfileId.make(id), "access-lost");
        } else {
          const useCheck = await call(
            "GET",
            `/v1/profiles/${encodeURIComponent(sync.remoteProfileId)}/composed-instructions`,
          );
          if (useCheck.status === 410) {
            await markSyncStatus(AgentProfileId.make(id), "archived");
          } else if (useCheck.status >= 400) {
            await markSyncStatus(AgentProfileId.make(id), "access-lost");
          }
        }
      }
      setMessage(
        `Loaded ${profiles.length} profiles and ${items<RemoteInstruction>(instructionsResponse.body).length} instruction sets.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not reach the profile service.");
    } finally {
      setPending(false);
    }
  };

  const pullProfile = async (remote: RemoteProfile, pulledAt: string) => {
    setPending(true);
    setMessage(null);
    try {
      const currentResponse = await call(
        "GET",
        `/v1/profiles/${encodeURIComponent(remote.profileId)}`,
      );
      if (currentResponse.status === 410) {
        await markSyncStatus(AgentProfileId.make(remote.profileId), "archived");
        setMessage("The profile is archived centrally. Existing local snapshots remain available.");
        return;
      }
      if (currentResponse.status >= 400) {
        await markSyncStatus(AgentProfileId.make(remote.profileId), "access-lost");
        throw new Error(errorMessage(currentResponse.body, "Profile access is unavailable."));
      }
      const current = currentResponse.body as RemoteProfile;
      const composition = await call(
        "GET",
        `/v1/profiles/${encodeURIComponent(remote.profileId)}/composed-instructions`,
      );
      if (composition.status === 410) {
        await markSyncStatus(AgentProfileId.make(remote.profileId), "archived");
        setMessage("The profile is archived centrally. Existing local snapshots remain available.");
        return;
      }
      if (composition.status === 403) {
        await markSyncStatus(AgentProfileId.make(remote.profileId), "access-lost");
        throw new Error("This installation no longer has permission to use the profile.");
      }
      if (composition.status >= 400) {
        throw new Error(errorMessage(composition.body, "Could not download this profile."));
      }
      const composed = record(composition.body);
      if (composed.profileVersion !== current.version) {
        throw new Error("The profile changed during download. Refresh the catalog and pull again.");
      }
      const profileId = AgentProfileId.make(remote.profileId);
      const existing = settings.agentProfiles[profileId];
      const previous = syncStates[profileId];
      const preferred = current.preferredProvider;
      const preferredModel = current.preferredModel;
      const mappedProvider = providers.find(
        (provider) =>
          provider.enabled &&
          String(provider.driver) === preferred &&
          preferredModel !== null &&
          provider.models.some((model) => model.slug === preferredModel),
      );
      const mappingRequired = existing
        ? (previous?.mappingRequired ?? false) ||
          !providers.some(
            (provider) =>
              provider.enabled &&
              provider.instanceId === existing.modelSelection.instanceId &&
              provider.models.some((model) => model.slug === existing.modelSelection.model),
          )
        : mappedProvider === undefined;
      const modelSelection = existing?.modelSelection ?? {
        instanceId: (mappedProvider?.instanceId ??
          preferred ??
          "unmapped") as AgentProfile["modelSelection"]["instanceId"],
        model:
          mappedProvider?.models.find((model) => model.slug === preferredModel)?.slug ??
          mappedProvider?.models[0]?.slug ??
          preferredModel ??
          "unmapped",
      };
      const profile: AgentProfile = {
        name: current.name,
        instructions: String(composed.instructions ?? current.instructions),
        modelSelection,
        runtimeMode: existing?.runtimeMode ?? "approval-required",
      };
      const instructionVersions = (composed.instructionVersions ??
        []) as AgentProfileInstructionVersion[];
      const state: AgentProfileSyncState = {
        remoteProfileId: profileId,
        remoteVersion: current.version,
        instructionVersions,
        lastSyncedAt: pulledAt,
        status: "synced",
        mappingRequired,
        remoteProfile: {
          name: current.name,
          description: current.description,
          instructions: current.instructions,
          preferredProvider: current.preferredProvider,
          preferredModel: current.preferredModel,
          preferredRuntimeMode: current.preferredRuntimeMode,
          groupInstructionIds: current.groupInstructionIds,
        },
        lastSyncedEffective: { name: profile.name, instructions: profile.instructions },
      };
      const result = await update({
        environmentId,
        input: {
          patch: {
            agentProfiles: { [profileId]: profile },
            agentProfileSyncState: { [profileId]: state },
          },
        },
      });
      if (result._tag === "Failure") throw new Error(reportFailure(result));
      setMessage(
        mappingRequired
          ? `${current.name} is stored offline. Map it to an available local provider and model before use.`
          : `${current.name} and its instruction versions are stored for offline use.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not download profile snapshot.");
    } finally {
      setPending(false);
    }
  };

  const createProfile = async () => {
    setPending(true);
    try {
      const response = await call("POST", "/v1/profiles", {
        name: newProfile.name.trim(),
        description: newProfile.description.trim(),
        instructions: newProfile.instructions,
        preferredProvider: newProfile.preferredProvider.trim() || null,
        preferredModel: newProfile.preferredModel.trim() || null,
        preferredRuntimeMode: null,
        groupInstructionIds: [],
      });
      if (response.status >= 400)
        throw new Error(errorMessage(response.body, "Could not create profile."));
      const created = response.body as RemoteProfile;
      setRemoteProfiles((current) => [created, ...current]);
      setNewProfile({
        name: "",
        description: "",
        instructions: "",
        preferredProvider: "",
        preferredModel: "",
      });
      startEdit(created);
      setMessage("Central profile created.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create profile.");
    } finally {
      setPending(false);
    }
  };

  const createInstruction = async () => {
    setPending(true);
    try {
      const response = await call("POST", "/v1/instructions", newInstruction);
      if (response.status >= 400)
        throw new Error(errorMessage(response.body, "Could not create instructions."));
      setRemoteInstructions((current) => [...current, response.body as RemoteInstruction]);
      setNewInstruction({ level: "global", name: "", content: "" });
      setMessage("Shared instructions created.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create instructions.");
    } finally {
      setPending(false);
    }
  };

  const saveInstruction = async (expectedVersion: number) => {
    if (!editingInstruction) return;
    setPending(true);
    try {
      const response = await call(
        "PUT",
        `/v1/instructions/${encodeURIComponent(editingInstruction.instructionId)}`,
        { level: editingInstruction.level, ...instructionDraft, expectedVersion },
      );
      if (response.status === 409) {
        setMessage("Shared instructions changed centrally. Refresh and compare their versions.");
        return;
      }
      if (response.status >= 400)
        throw new Error(errorMessage(response.body, "Could not update instructions."));
      const updated = response.body as RemoteInstruction;
      setRemoteInstructions((current) =>
        current.map((item) => (item.instructionId === updated.instructionId ? updated : item)),
      );
      setEditingInstruction(null);
      setMessage("Shared instruction version published.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update instructions.");
    } finally {
      setPending(false);
    }
  };

  const loadInstructionHistory = async (instruction: RemoteInstruction) => {
    setPending(true);
    try {
      const response = await call(
        "GET",
        `/v1/instructions/${encodeURIComponent(instruction.instructionId)}/versions`,
      );
      if (response.status >= 400)
        throw new Error(errorMessage(response.body, "Could not load instruction history."));
      setInstructionHistory(items<Record<string, unknown>>(response.body));
      setInstructionHistoryTarget(instruction);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load instruction history.");
    } finally {
      setPending(false);
    }
  };

  const restoreInstructionVersion = async (
    instruction: RemoteInstruction,
    version: Record<string, unknown>,
  ) => {
    setPending(true);
    try {
      const response = await call(
        "POST",
        `/v1/instructions/${encodeURIComponent(instruction.instructionId)}/restore/${String(version.version)}?expected_version=${instruction.version}`,
      );
      if (response.status >= 400)
        throw new Error(errorMessage(response.body, "Could not restore instruction version."));
      const restored = response.body as RemoteInstruction;
      setRemoteInstructions((current) =>
        current.map((item) => (item.instructionId === restored.instructionId ? restored : item)),
      );
      setInstructionHistory([]);
      setInstructionHistoryTarget(null);
      setMessage(`Restored as new instruction version ${restored.version}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not restore instruction version.");
    } finally {
      setPending(false);
    }
  };

  const loadGrants = async (profile: RemoteProfile) => {
    setPending(true);
    try {
      const response = await call(
        "GET",
        `/v1/profiles/${encodeURIComponent(profile.profileId)}/grants`,
      );
      if (response.status >= 400)
        throw new Error(errorMessage(response.body, "Could not load access grants."));
      setGrants(items<ProfileGrant>(response.body));
      setSharingProfileId(profile.profileId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load access grants.");
    } finally {
      setPending(false);
    }
  };

  const grantProfile = async () => {
    if (!sharingProfileId || !shareSubject.trim()) return;
    setPending(true);
    try {
      const response = await call(
        "PUT",
        `/v1/profiles/${encodeURIComponent(sharingProfileId)}/grants`,
        { subjectId: shareSubject.trim(), role: shareRole },
      );
      if (response.status >= 400)
        throw new Error(errorMessage(response.body, "Could not grant profile access."));
      setGrants((current) => {
        const remaining = current.filter((grant) => grant.subjectId !== shareSubject.trim());
        return [...remaining, { subjectId: shareSubject.trim(), role: shareRole }];
      });
      setShareSubject("");
      setMessage("Profile access granted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not grant profile access.");
    } finally {
      setPending(false);
    }
  };

  const revokeGrant = async (subjectId: string) => {
    if (!sharingProfileId) return;
    setPending(true);
    try {
      const response = await call(
        "DELETE",
        `/v1/profiles/${encodeURIComponent(sharingProfileId)}/grants/${encodeURIComponent(subjectId)}`,
      );
      if (response.status >= 400)
        throw new Error(errorMessage(response.body, "Could not revoke profile access."));
      setGrants((current) => current.filter((grant) => grant.subjectId !== subjectId));
      setMessage("Access revoked. Previously pulled snapshots remain available.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not revoke profile access.");
    } finally {
      setPending(false);
    }
  };

  const archiveProfile = async (remote: RemoteProfile) => {
    setPending(true);
    try {
      const response = await call("DELETE", `/v1/profiles/${encodeURIComponent(remote.profileId)}`);
      if (response.status >= 400)
        throw new Error(errorMessage(response.body, "Could not archive profile."));
      const id = AgentProfileId.make(remote.profileId);
      const sync = syncStates[id];
      if (sync) {
        const saved = await update({
          environmentId,
          input: { patch: { agentProfileSyncState: { [id]: { ...sync, status: "archived" } } } },
        });
        if (saved._tag === "Failure") throw new Error(reportFailure(saved));
      }
      setRemoteProfiles((current) =>
        current.filter((profile) => profile.profileId !== remote.profileId),
      );
      setMessage("Profile archived. Existing local snapshots remain available.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not archive profile.");
    } finally {
      setPending(false);
    }
  };

  const startEdit = (profile: RemoteProfile) => {
    setEditing(profile);
    setEditingLocalOverride(false);
    setDraft({
      name: profile.name,
      description: profile.description,
      instructions: profile.instructions,
      preferredProvider: profile.preferredProvider,
      preferredModel: profile.preferredModel,
      preferredRuntimeMode: profile.preferredRuntimeMode,
      groupInstructionIds: [...profile.groupInstructionIds],
    });
    setConflict(null);
  };

  const reviewLocalOverride = (remote: RemoteProfile, local: AgentProfile) => {
    setEditing(remote);
    setDraft({
      name: local.name,
      description: remote.description,
      instructions: local.instructions,
      preferredProvider: remote.preferredProvider,
      preferredModel: remote.preferredModel,
      preferredRuntimeMode: remote.preferredRuntimeMode,
      groupInstructionIds: remote.groupInstructionIds,
    });
    setEditingLocalOverride(true);
    setConflict(null);
  };

  const publish = async (expectedVersion: number) => {
    if (!editing || !draft) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await call("PUT", `/v1/profiles/${encodeURIComponent(editing.profileId)}`, {
        ...draft,
        expectedVersion,
      });
      if (response.status === 409) {
        const latest = await call("GET", `/v1/profiles/${encodeURIComponent(editing.profileId)}`);
        if (latest.status < 400) setConflict(latest.body as RemoteProfile);
        setMessage("The central profile changed. Compare both versions before publishing again.");
        return;
      }
      if (response.status >= 400)
        throw new Error(errorMessage(response.body, "Could not publish changes."));
      const updated = response.body as RemoteProfile;
      setRemoteProfiles((current) =>
        current.map((item) => (item.profileId === updated.profileId ? updated : item)),
      );
      setEditing(updated);
      setEditingLocalOverride(false);
      setDraft({
        name: updated.name,
        description: updated.description,
        instructions: updated.instructions,
        preferredProvider: updated.preferredProvider,
        preferredModel: updated.preferredModel,
        preferredRuntimeMode: updated.preferredRuntimeMode,
        groupInstructionIds: updated.groupInstructionIds,
      });
      setConflict(null);
      setMessage("Central profile updated. Pull it to refresh its local snapshot.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not publish changes.");
    } finally {
      setPending(false);
    }
  };

  const localProfiles = settings.agentProfiles;
  return (
    <SettingsSection id="agent-profile-service" title="Shared profile service">
      <p className="mb-3 text-sm text-muted-foreground">
        Connect this T3 server to a central catalog. Pulled profiles and their shared-instruction
        versions are saved locally and keep working offline.
      </p>
      <div className="grid gap-2 rounded-lg border p-3">
        <Input
          aria-label="Profile service endpoint"
          value={endpoint}
          onChange={(event) => setEndpoint(event.currentTarget.value)}
          placeholder="https://profiles.example.com"
        />
        <Input
          aria-label="Profile service access token"
          type="password"
          autoComplete="new-password"
          value={token}
          onChange={(event) => setToken(event.currentTarget.value)}
          placeholder={
            connection.credentialConfigured
              ? "Saved securely; leave blank to keep"
              : "OIDC access token"
          }
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void clearConnection()}
            disabled={pending || !connection.credentialConfigured}
          >
            Disconnect
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void saveConnection()}
            disabled={pending || !endpoint.trim()}
          >
            Save connection
          </Button>
          <Button
            size="sm"
            onClick={() => void refreshCatalog()}
            disabled={pending || !connection.endpoint || !connection.credentialConfigured}
          >
            Refresh catalog
          </Button>
        </div>
      </div>

      {message ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}

      {remoteProfiles.length > 0 ? (
        <div className="mt-4 grid gap-2">
          <h3 className="text-sm font-medium">Central profiles</h3>
          {remoteProfiles.map((remote) => {
            const id = AgentProfileId.make(remote.profileId);
            const sync = syncStates[id];
            const local = localProfiles[id];
            const hasLocalOverride =
              sync !== undefined &&
              local !== undefined &&
              (local.name !== sync.lastSyncedEffective.name ||
                local.instructions !== sync.lastSyncedEffective.instructions);
            return (
              <div key={remote.profileId} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{remote.name}</div>
                    <div className="text-xs text-muted-foreground">
                      Central v{remote.version}
                      {sync ? ` · last synced ${sync.lastSyncedAt}` : " · not downloaded"}
                      {sync?.status === "access-lost" ? " · source unavailable" : ""}
                    </div>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void pullProfile(remote, new Date().toISOString())}
                    disabled={pending}
                  >
                    Pull snapshot
                  </Button>
                  {hasLocalOverride && local ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => reviewLocalOverride(remote, local)}
                      disabled={pending}
                    >
                      Review local changes
                    </Button>
                  ) : null}
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => startEdit(remote)}
                    disabled={pending}
                  >
                    Edit central
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void archiveProfile(remote)}
                    disabled={pending}
                  >
                    Archive
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void loadGrants(remote)}
                    disabled={pending}
                  >
                    Sharing
                  </Button>
                </div>
                {sync ? (
                  <div className="mt-2 text-xs text-muted-foreground">
                    Snapshot v{sync.remoteVersion}; {sync.instructionVersions.length} shared
                    instruction version(s)
                    {sync.mappingRequired ? " · local provider/model mapping required" : ""}
                    {hasLocalOverride ? " · local profile override" : ""}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="mt-4 grid gap-2 rounded-lg border p-3">
        <h3 className="text-sm font-medium">Create a central profile</h3>
        <Input
          aria-label="New central profile name"
          value={newProfile.name}
          onChange={(event) => setNewProfile({ ...newProfile, name: event.currentTarget.value })}
          placeholder="Security reviewer"
        />
        <Input
          aria-label="New central profile description"
          value={newProfile.description}
          onChange={(event) =>
            setNewProfile({ ...newProfile, description: event.currentTarget.value })
          }
          placeholder="What this profile does"
        />
        <Input
          aria-label="Preferred provider family"
          value={newProfile.preferredProvider}
          onChange={(event) =>
            setNewProfile({ ...newProfile, preferredProvider: event.currentTarget.value })
          }
          placeholder="Preferred provider family, such as codex"
        />
        <Input
          aria-label="Preferred model ID"
          value={newProfile.preferredModel}
          onChange={(event) =>
            setNewProfile({ ...newProfile, preferredModel: event.currentTarget.value })
          }
          placeholder="Preferred model ID"
        />
        <Textarea
          aria-label="New profile-specific instructions"
          rows={4}
          value={newProfile.instructions}
          onChange={(event) =>
            setNewProfile({ ...newProfile, instructions: event.currentTarget.value })
          }
          placeholder="Profile-specific instructions"
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => void createProfile()}
            disabled={pending || !newProfile.name.trim()}
          >
            Create profile
          </Button>
        </div>
      </div>

      {connection.endpoint && connection.credentialConfigured ? (
        <div className="mt-4 rounded-lg border p-3">
          <h3 className="text-sm font-medium">Shared instructions</h3>
          <ul className="mt-2 grid gap-1 text-sm">
            {remoteInstructions.map((instruction) => (
              <li key={instruction.instructionId} className="flex justify-between gap-3">
                <span>
                  {instruction.name}{" "}
                  <span className="text-xs text-muted-foreground">{instruction.level}</span>
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  v{instruction.version}
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setEditingInstruction(instruction);
                      setInstructionDraft({ name: instruction.name, content: instruction.content });
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void loadInstructionHistory(instruction)}
                  >
                    History
                  </Button>
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 grid gap-2 border-t pt-3">
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={newInstruction.level}
              onChange={(event) =>
                setNewInstruction({
                  ...newInstruction,
                  level: event.currentTarget.value as "global" | "group",
                })
              }
              aria-label="Shared instruction level"
            >
              <option value="global">Global instruction</option>
              <option value="group">Reusable group instruction</option>
            </select>
            <Input
              aria-label="Shared instruction name"
              value={newInstruction.name}
              onChange={(event) =>
                setNewInstruction({ ...newInstruction, name: event.currentTarget.value })
              }
              placeholder="Coding principles"
            />
            <Textarea
              aria-label="Shared instruction content"
              rows={4}
              value={newInstruction.content}
              onChange={(event) =>
                setNewInstruction({ ...newInstruction, content: event.currentTarget.value })
              }
              placeholder="Instruction text"
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void createInstruction()}
                disabled={pending || !newInstruction.name.trim()}
              >
                Add shared instructions
              </Button>
            </div>
          </div>
          {instructionHistory.length > 0 ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs">Instruction version history</summary>
              <div className="mt-2 grid gap-2">
                {instructionHistory.map((version) => (
                  <div key={String(version.version)} className="rounded bg-muted p-2 text-xs">
                    <pre className="whitespace-pre-wrap">
                      v{String(version.version)} · {String(version.name)}
                      {"\n"}
                      {String(version.content)}
                    </pre>
                    {instructionHistoryTarget ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={
                          pending || Number(version.version) === instructionHistoryTarget.version
                        }
                        onClick={() =>
                          void restoreInstructionVersion(instructionHistoryTarget, version)
                        }
                      >
                        Restore as new version
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      {sharingProfileId ? (
        <div className="mt-4 grid gap-2 rounded-lg border p-3">
          <h3 className="text-sm font-medium">Sharing profile</h3>
          <div className="flex gap-2">
            <Input
              aria-label="User or team identifier"
              value={shareSubject}
              onChange={(event) => setShareSubject(event.currentTarget.value)}
              placeholder="User sub or group:team-name"
            />
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={shareRole}
              onChange={(event) =>
                setShareRole(event.currentTarget.value as "read" | "use" | "edit")
              }
              aria-label="Profile access role"
            >
              <option value="read">Read</option>
              <option value="use">Use</option>
              <option value="edit">Edit</option>
            </select>
            <Button
              size="sm"
              onClick={() => void grantProfile()}
              disabled={pending || !shareSubject.trim()}
            >
              Grant
            </Button>
          </div>
          {grants.map((grant) => (
            <div key={grant.subjectId} className="flex items-center justify-between text-sm">
              <span>
                {grant.subjectId} · {grant.role}
              </span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void revokeGrant(grant.subjectId)}
                disabled={pending}
              >
                Revoke
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {editing && draft ? (
        <div className="mt-4 grid gap-2 rounded-lg border p-3">
          <h3 className="text-sm font-medium">
            {editingLocalOverride ? "Review local changes for" : "Edit"} {editing.name} · central v
            {editing.version}
          </h3>
          <Input
            aria-label="Central profile name"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
          />
          <Input
            aria-label="Central profile description"
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })}
          />
          <Input
            aria-label="Preferred provider family"
            value={draft.preferredProvider ?? ""}
            onChange={(event) =>
              setDraft({
                ...draft,
                preferredProvider: event.currentTarget.value.trim() || null,
              })
            }
          />
          <Input
            aria-label="Preferred model ID"
            value={draft.preferredModel ?? ""}
            onChange={(event) =>
              setDraft({ ...draft, preferredModel: event.currentTarget.value.trim() || null })
            }
          />
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm"
            aria-label="Preferred runtime mode"
            value={draft.preferredRuntimeMode ?? ""}
            onChange={(event) =>
              setDraft({
                ...draft,
                preferredRuntimeMode: event.currentTarget.value || null,
              })
            }
          >
            <option value="">No runtime preference</option>
            <option value="approval-required">Approval required (advisory)</option>
            <option value="auto-accept-edits">Auto accept edits (advisory)</option>
            <option value="auto">Auto (advisory)</option>
            <option value="full-access">Full access (advisory)</option>
          </select>
          <Textarea
            aria-label="Profile-specific instructions"
            rows={6}
            value={draft.instructions}
            onChange={(event) => setDraft({ ...draft, instructions: event.currentTarget.value })}
          />
          {remoteInstructions.some((instruction) => instruction.level === "group") ? (
            <fieldset className="grid gap-1 rounded-md border p-2">
              <legend className="px-1 text-xs font-medium">Applied group instructions</legend>
              {remoteInstructions
                .filter((instruction) => instruction.level === "group")
                .map((instruction) => {
                  const included = draft.groupInstructionIds.includes(instruction.instructionId);
                  return (
                    <label
                      key={instruction.instructionId}
                      className="flex items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={included}
                        onChange={() =>
                          setDraft({
                            ...draft,
                            groupInstructionIds: included
                              ? draft.groupInstructionIds.filter(
                                  (id) => id !== instruction.instructionId,
                                )
                              : [...draft.groupInstructionIds, instruction.instructionId],
                          })
                        }
                      />
                      {instruction.name}
                    </label>
                  );
                })}
            </fieldset>
          ) : null}
          <p className="text-xs text-muted-foreground">
            This edits only profile-specific text. Shared instructions and local provider/runtime
            choices stay separate.
          </p>
          {conflict ? (
            <div className="grid gap-2 rounded-md bg-muted p-3 text-xs">
              <strong>Central version v{conflict.version}</strong>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap">
                {conflict.instructions}
              </pre>
              <div className="flex gap-2">
                <Button size="xs" variant="outline" onClick={() => startEdit(conflict)}>
                  Use central version
                </Button>
                <Button size="xs" variant="outline" onClick={() => void publish(conflict.version)}>
                  Reapply my draft to v{conflict.version}
                </Button>
              </div>
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditing(null);
                setDraft(null);
                setEditingLocalOverride(false);
                setConflict(null);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void publish(editing.version)}
              disabled={pending || !draft.name.trim()}
            >
              {editingLocalOverride ? "Publish local changes" : "Publish with version check"}
            </Button>
          </div>
        </div>
      ) : null}

      {editingInstruction ? (
        <div className="mt-4 grid gap-2 rounded-lg border p-3">
          <h3 className="text-sm font-medium">
            Edit shared instructions · v{editingInstruction.version}
          </h3>
          <Input
            aria-label="Shared instruction title"
            value={instructionDraft.name}
            onChange={(event) =>
              setInstructionDraft({ ...instructionDraft, name: event.currentTarget.value })
            }
          />
          <Textarea
            aria-label="Shared instruction text"
            rows={5}
            value={instructionDraft.content}
            onChange={(event) =>
              setInstructionDraft({ ...instructionDraft, content: event.currentTarget.value })
            }
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditingInstruction(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void saveInstruction(editingInstruction.version)}
              disabled={pending || !instructionDraft.name.trim()}
            >
              Publish instruction version
            </Button>
          </div>
        </div>
      ) : null}
    </SettingsSection>
  );
}
