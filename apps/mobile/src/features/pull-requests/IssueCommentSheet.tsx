import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useRef, useState } from "react";
import { Platform } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { issueTarget, type IssueParams } from "./issueRoute";
import { PullRequestSheetContent as SheetContent } from "./PullRequestSheetContent";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { usePullRequestReviewDraft } from "./usePullRequestReviewDraft";

/**
 * The comment draft shares the pull request draft store. A host numbers issues and pull requests
 * from one sequence per repository, so their keys never collide.
 */
export function IssueCommentSheet({ route }: StaticScreenProps<IssueParams>) {
  const params = route.params;
  const target = issueTarget(params);
  const navigation = useNavigation();
  const result = useEnvironmentQuery(composerPullRequests.issueDetail(target));
  const { refresh: refreshDetail } = result;
  useFocusEffect(useCallback(() => refreshDetail(), [refreshDetail]));
  const connected = usePullRequestConnected(params.environmentId);
  const permitted = useAtomValue(
    composerPullRequests.issueComment.permissionAtom(target.environmentId),
  );
  const comment = useAtomCommand(composerPullRequests.issueComment, { reportFailure: false });
  const store = usePullRequestReviewDraft(params);
  const body = store.draft.comment;
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canComment = connected && permitted && result.data?.canComment === true;
  const canSubmit = store.ready && canComment && body.trim().length > 0;
  const post = async () => {
    if (pending.current || !canSubmit) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const submitted = body;
      const response = await comment({ ...target, input: { ...target.input, body: submitted } });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      store.update((current) => ({
        ...current,
        comment: current.comment === submitted ? "" : current.comment,
      }));
      await store.flush();
      navigation.goBack();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The provider could not post this comment.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <SheetContent
      title="Add comment"
      subtitle={`#${params.number} · ${params.repository}`}
      busy={busy}
      footer={
        <MaterialButton
          label={busy ? "Posting…" : "Post comment"}
          fullWidth
          tone={Platform.OS === "android" ? "primary" : "contrast"}
          loading={busy}
          disabled={!canSubmit || result.isPending || result.error !== null}
          onPress={() => void post()}
        />
      }
    >
      <Text className="px-4 text-xs text-foreground-muted">Comment</Text>
      <TextInput
        multiline
        accessibilityLabel="Comment"
        placeholder="Write a comment…"
        placeholderTextColorClassName="accent-foreground-muted"
        editable={store.ready && !busy}
        value={body}
        maxLength={65536}
        onChangeText={(next) => store.update((current) => ({ ...current, comment: next }))}
        className="min-h-36 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
        style={{ textAlignVertical: "top" }}
      />
      {!connected ? (
        <Text className="text-sm text-foreground-muted">
          Reconnect to post. Your comment is kept on this device.
        </Text>
      ) : result.data && !canComment ? (
        <Text className="text-sm text-foreground-muted">
          You can't comment on this issue. Your comment is kept on this device.
        </Text>
      ) : null}
      {error || result.error || store.error ? (
        <Text selectable className="text-sm text-danger-foreground">
          {error ?? result.error ?? store.error}
        </Text>
      ) : null}
    </SheetContent>
  );
}
