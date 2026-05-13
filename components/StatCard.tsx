interface StatCardProps {
  label: string
  value: number | string
  icon?: string
  color?: string
}

export default function StatCard({ label, value, icon, color = 'bg-white' }: StatCardProps) {
  return (
    <div className={`${color} rounded-xl p-4 shadow-sm border border-gray-100`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-500 uppercase tracking-wide font-medium">{label}</span>
        {icon && <span className="text-lg">{icon}</span>}
      </div>
      <div className="text-2xl font-bold text-gray-900">{value}</div>
    </div>
  )
}
