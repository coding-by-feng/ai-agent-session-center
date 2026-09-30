import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import type { SetupConfig } from '@/types/electron'
import type { StepProps } from '../SetupWizard'
import Select from '@/components/ui/Select'
import styles from '@/styles/modules/SetupWizard.module.css'

const DENSITY_OPTIONS: { value: SetupConfig['hookDensity']; label: string; desc: string }[] = [
  { value: 'high', label: 'High', desc: 'All 14 events. Full monitoring + approval detection.' },
  { value: 'medium', label: 'Medium', desc: '12 events. Good balance of monitoring and overhead.' },
  { value: 'low', label: 'Low', desc: '5 events. Minimal overhead, basic status tracking.' },
]

const HISTORY_OPTIONS = [
  { value: 12, label: '12 hours' },
  { value: 24, label: '24 hours' },
  { value: 48, label: '48 hours' },
  { value: 168, label: '7 days' },
]

const passwordSchema = z.string()
  .min(8, 'Min 8 characters')
  .regex(/[A-Z]/, 'Need uppercase letter')
  .regex(/[a-z]/, 'Need lowercase letter')
  .regex(/[0-9]/, 'Need digit')
  .regex(/[^A-Za-z0-9]/, 'Need special character')

// A password is REQUIRED at setup — there is deliberately no opt-out. Without
// one, `authManager`'s gate refuses every non-loopback client (403 / ws 4003),
// so the LAN address the Connected-Devices panel advertises for phones is dead
// on arrival. An opt-out here produced an install that silently could not do
// the thing the UI invites the user to do.
const formSchema = z.object({
  port: z.number({ error: 'Must be a number' }).int().min(1, 'Min 1').max(65535, 'Max 65535'),
  enableCodex: z.boolean(),
  hookDensity: z.enum(['high', 'medium', 'low']),
  sessionHistoryHours: z.number(),
  password: z.string(),
  confirmPassword: z.string(),
}).superRefine((data, ctx) => {
  const result = passwordSchema.safeParse(data.password)
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({ ...issue, path: ['password'] })
    }
  }
  if (data.password !== data.confirmPassword) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Passwords do not match', path: ['confirmPassword'] })
  }
})

type FormValues = z.infer<typeof formSchema>

export default function ConfigureStep({ config, setConfig, onNext }: StepProps) {
  const [saving, setSaving] = useState(false)

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      port: config.port,
      enableCodex: config.enabledClis.includes('codex'),
      hookDensity: config.hookDensity,
      sessionHistoryHours: config.sessionHistoryHours,
      password: '',
      confirmPassword: '',
    },
  })

  const hookDensity = watch('hookDensity')

  const onSubmit = async (data: FormValues) => {
    const clis: SetupConfig['enabledClis'] = ['claude']
    if (data.enableCodex) clis.push('codex')

    const cfg: SetupConfig = {
      port: data.port,
      enabledClis: clis,
      hookDensity: data.hookDensity,
      debug: false,
      sessionHistoryHours: data.sessionHistoryHours,
    }

    // The wizard's own state must NOT carry the plaintext password — it is
    // passed to the IPC (which hashes it) and dropped. Earlier this step
    // validated a password and then never sent it anywhere, so every install
    // completed with no password at all however carefully it was typed.
    setConfig(cfg)

    if (window.electronAPI) {
      setSaving(true)
      try {
        await window.electronAPI.saveConfig({ ...cfg, password: data.password })
      } catch {
        setSaving(false)
        return
      }
      setSaving(false)
    }

    onNext()
  }

  return (
    <div className={styles.stepContainer}>
      <form className={styles.form} onSubmit={handleSubmit(onSubmit)}>
        {/* CLI Selection */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>AI CLIs to Monitor</label>
          <div className={styles.checkboxGroup}>
            <label className={`${styles.checkbox} ${styles.disabled}`}>
              <input type="checkbox" checked disabled />
              Claude Code
            </label>
            <label className={styles.checkbox}>
              <input type="checkbox" {...register('enableCodex')} />
              Codex
            </label>
          </div>
        </div>

        {/* Hook Density */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Hook Density</label>
          <div className={styles.radioGroup}>
            {DENSITY_OPTIONS.map(opt => (
              <label
                key={opt.value}
                className={`${styles.radioOption} ${hookDensity === opt.value ? styles.selected : ''}`}
              >
                <input
                  type="radio"
                  value={opt.value}
                  {...register('hookDensity')}
                />
                <span className={styles.radioTitle}>{opt.label}</span>
                <span className={styles.radioDesc}>{opt.desc}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Port */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Dashboard Port</label>
          <input
            type="number"
            className={styles.numberInput}
            {...register('port', { valueAsNumber: true })}
          />
          {errors.port && <div className={styles.fieldError}>{errors.port.message}</div>}
        </div>

        {/* History Retention */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Session History Retention</label>
          <Select
            value={String(watch('sessionHistoryHours'))}
            onChange={(val) => setValue('sessionHistoryHours', Number(val))}
            options={HISTORY_OPTIONS.map(opt => ({
              value: String(opt.value),
              label: opt.label,
            }))}
            style={{ width: '100%' }}
          />
        </div>

        {/* Password — required, no opt-out (see formSchema's comment) */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="password">
            Dashboard Password <span className={styles.required}>required</span>
          </label>
          <div className={styles.passwordFields}>
            <input
              id="password"
              type="password"
              className={styles.textInput}
              placeholder="Password"
              autoComplete="new-password"
              {...register('password')}
            />
            {errors.password && <div className={styles.fieldError}>{errors.password.message}</div>}
            <input
              type="password"
              className={styles.textInput}
              placeholder="Confirm password"
              autoComplete="new-password"
              {...register('confirmPassword')}
            />
            {errors.confirmPassword && <div className={styles.fieldError}>{errors.confirmPassword.message}</div>}
          </div>
          <div className={styles.fieldHint}>
            Needed to open the dashboard from another device. Without one, phones
            and other computers on your network are refused — only this Mac can
            connect. This Mac itself never has to type it.
          </div>
        </div>

        <button className={styles.primaryBtn} type="submit" disabled={saving}>
          {saving ? 'Saving...' : 'Continue'}
        </button>
      </form>
    </div>
  )
}
