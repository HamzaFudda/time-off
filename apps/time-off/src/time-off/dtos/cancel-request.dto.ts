import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CancelRequestDto {
  @ApiProperty({
    description: 'ID of the employee cancelling their own request',
    example: 'emp-123',
  })
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @ApiProperty({ description: 'Optional cancellation reason', required: false })
  @IsString()
  @IsOptional()
  reason?: string;
}
