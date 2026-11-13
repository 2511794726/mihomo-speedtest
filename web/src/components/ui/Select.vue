<script setup>
import {
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectPortal,
  SelectContent,
  SelectViewport,
  SelectItem,
  SelectItemText,
  SelectItemIndicator,
} from 'reka-ui';
import { Icon } from '@iconify/vue';
import { cn } from '../../lib/utils.js';

const model = defineModel({ type: [String, Number], default: '' });

const props = defineProps({
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '请选择' },
  disabled: { type: Boolean, default: false },
  class: { type: String, default: '' },
});
</script>

<template>
  <SelectRoot v-model="model" :disabled="props.disabled">
    <SelectTrigger
      :class="
        cn(
          'inline-flex h-10 items-center justify-between gap-2 rounded-xl bg-white/[0.06] backdrop-blur-xl border border-white/10 px-3.5 text-sm text-slate-100 transition-colors hover:bg-white/[0.1] focus:outline-none focus:border-[#0A84FF]/70 focus:ring-2 focus:ring-[#0A84FF]/25 disabled:opacity-50 cursor-pointer',
          props.class,
        )
      "
    >
      <SelectValue :placeholder="props.placeholder" class="truncate" />
      <Icon icon="mdi:chevron-down" class="h-4 w-4 shrink-0 text-slate-400" />
    </SelectTrigger>

    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="6"
        class="z-50 max-h-72 min-w-[var(--reka-select-trigger-width)] overflow-hidden rounded-xl bg-slate-900/85 backdrop-blur-3xl backdrop-saturate-150 border border-white/20 shadow-2xl p-1 text-slate-100"
      >
        <SelectViewport class="p-0.5">
          <SelectItem
            v-for="opt in props.options"
            :key="String(opt.value)"
            :value="String(opt.value)"
            class="relative flex w-full cursor-pointer select-none items-center rounded-lg py-2 pl-8 pr-3 text-sm outline-none data-[highlighted]:bg-[#0A84FF]/25 data-[highlighted]:text-white transition-colors"
          >
            <span class="absolute left-2.5 flex h-4 w-4 items-center justify-center text-[#0A84FF]">
              <SelectItemIndicator>
                <Icon icon="mdi:check" class="h-4 w-4" />
              </SelectItemIndicator>
            </span>
            <SelectItemText>{{ opt.label }}</SelectItemText>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
