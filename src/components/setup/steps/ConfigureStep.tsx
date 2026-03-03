import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import type { SetupConfig } from '@/types/electron'
import type { StepProps } from '../SetupWizard'
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

const formSchema = z.object({
  port: z.number({ error: 'Must be a number' }).int().min(1, 'Min 1').max(65535, 'Max 65535'),
  enableGemini: z.boolean(),
  enableCodex: z.boolean(),
  hookDensity: z.enum(['high', 'medium', 'low']),
  sessionHistoryHours: z.number(),
  enablePassword: z.boolean(),
  password: z.string().optional(),
  confirmPassword: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.enablePassword) {
    const pw = data.password ?? ''
    const result = passwordSchema.safeParse(pw)
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue, path: ['password'] })
      }
    }
    if (pw !== (data.confirmPassword ?? '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Passwords do not match', path: ['confirmPassword'] })
    }
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
      enableGemini: config.enabledClis.includes('gemini'),
      enableCodex: config.enabledClis.includes('codex'),
      hookDensity: config.hookDensity,
      sessionHistoryHours: config.sessionHistoryHours,
      enablePassword: false,
      password: '',
      confirmPassword: '',
    },
  })

  const hookDensity = watch('hookDensity')
  const enablePassword = watch('enablePassword')

  const onSubmit = async (data: FormValues) => {
    const clis: SetupConfig['enabledClis'] = ['claude']
    if (data.enableGemini) clis.push('gemini')
    if (data.enableCodex) clis.push('codex')

    const cfg: SetupConfig = {
      port: data.port,
      enabledClis: clis,
      hookDensity: data.hookDensity,
      debug: false,
      sessionHistoryHours: data.sessionHistoryHours,
    }

    setConfig(cfg)

    if (window.electronAPI) {
      setSaving(true)
      try {
        await window.electronAPI.saveConfig(cfg)
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
              <input type="checkbox" {...register('enableGemini')} />
              Gemini CLI
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
          <select
            className={styles.selectInput}
            {...register('sessionHistoryHours', { valueAsNumber: true })}
          >
            {HISTORY_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Password */}
        <div className={styles.fieldGroup}>
          <label className={styles.toggleRow} htmlFor="enablePassword">
            <input
              id="enablePassword"
              type="checkbox"
              {...register('enablePassword')}
              onChange={(e) => {
                setValue('enablePassword', e.target.checked)
                if (!e.target.checked) {
                  setValue('password', '')
                  setValue('confirmPassword', '')
                }
              }}
            />
            <span className={styles.toggleSwitch} />
            Require password to access dashboard
          </label>

          {enablePassword && (
            <div className={styles.passwordFields}>
              <input
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
          )}
        </div>

        <button className={styles.primaryBtn} type="submit" disabled={saving}>
          {saving ? 'Saving...' : 'Continue'}
        </button>
      </form>
    </div>
  )
}
