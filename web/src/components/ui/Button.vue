<script setup>
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]/70 disabled:pointer-events-none disabled:opacity-45 whitespace-nowrap cursor-pointer select-none',
  {
    variants: {
      variant: {
        primary:
          'bg-[#0A84FF] hover:bg-[#0070E0] text-white shadow-[0_4px_16px_rgba(10,132,255,0.35)] border border-white/15',
        secondary:
          'bg-white/[0.08] hover:bg-white/[0.14] text-slate-100 border border-white/15 backdrop-blur-xl ring-1 ring-inset ring-white/5',
        danger:
          'bg-[#FF453A]/15 hover:bg-[#FF453A]/25 text-[#FF6961] border border-[#FF453A]/35 backdrop-blur-xl',
        ghost: 'hover:bg-white/[0.08] text-slate-300 hover:text-white',
      },
      size: {
        default: 'h-10 px-4 text-sm',
        sm: 'h-8 px-3 text-xs rounded-lg',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'default',
    },
  },
);

const props = defineProps({
  variant: { type: String, default: 'secondary' },
  size: { type: String, default: 'default' },
  class: { type: String, default: '' },
});
</script>

<template>
  <button :class="cn(buttonVariants({ variant, size }), props.class)">
    <slot />
  </button>
</template>
