<script setup>
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold border backdrop-blur-md whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'bg-white/[0.08] border-white/15 text-slate-300',
        success: 'bg-[#30D158]/15 border-[#30D158]/30 text-[#30D158]',
        danger: 'bg-[#FF453A]/15 border-[#FF453A]/30 text-[#FF6961]',
        warning: 'bg-[#FF9F0A]/15 border-[#FF9F0A]/30 text-[#FFB340]',
        info: 'bg-[#0A84FF]/15 border-[#0A84FF]/35 text-[#64D2FF]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

const props = defineProps({
  variant: { type: String, default: 'default' },
  class: { type: String, default: '' },
});
</script>

<template>
  <span :class="cn(badgeVariants({ variant }), props.class)">
    <slot />
  </span>
</template>
