export interface ConnectorNameDraft {
  persistedName: string;
  draftName: string;
  dirty: boolean;
}

export type ConnectorNameDraftAction =
  | { type: "edit"; value: string }
  | { type: "snapshot"; persistedName: string }
  | { type: "saved"; persistedName: string };

export function createConnectorNameDraft(persistedName: string): ConnectorNameDraft {
  return { persistedName, draftName: persistedName, dirty: false };
}

export function connectorNameDraftReducer(
  state: ConnectorNameDraft,
  action: ConnectorNameDraftAction,
): ConnectorNameDraft {
  if (action.type === "edit") {
    return {
      ...state,
      draftName: action.value,
      dirty: action.value !== state.persistedName,
    };
  }
  if (action.type === "saved") return createConnectorNameDraft(action.persistedName);
  if (state.dirty && state.draftName !== action.persistedName) {
    return { ...state, persistedName: action.persistedName };
  }
  return createConnectorNameDraft(action.persistedName);
}
