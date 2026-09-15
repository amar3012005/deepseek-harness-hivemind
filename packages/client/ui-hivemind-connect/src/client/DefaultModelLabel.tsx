import type { InputControlOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** HIVE-MIND keeps the configured model/effort private while retaining the native seat geometry. */
export function DefaultModelLabel({ locked }: InputControlOwnerProps) {
  return <span
    aria-label="Default model"
    aria-disabled={locked || undefined}
    data-hivemind-default-model=""
  >Default</span>
}
